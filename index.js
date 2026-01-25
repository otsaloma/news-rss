// -*- coding: utf-8-unix -*-

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.71.2/+esm";

const PARAMS = new URLSearchParams(window.location.search);

// Load needed key and token from URL parameters or local storage.
let ANTHROPIC_API_KEY = PARAMS.get("key") || localStorage.getItem("ANTHROPIC_API_KEY");
let PROXY_TOKEN = PARAMS.get("token") || localStorage.getItem("PROXY_TOKEN");

let PROXY = "https://ep3tfancwtwxecots3p6txr3ka0xfcrr.lambda-url.eu-north-1.on.aws/";
if (PARAMS.get("proxy-local")) {
    PROXY = "http://localhost:8001/";
    PROXY_TOKEN = "not-needed-locally";
}
console.log(`Using proxy ${PROXY}`);

let FEEDS = JSON.parse(localStorage.getItem("FEEDS")) || [
    "https://feeds.kauppalehti.fi/rss/main",
    "https://www.hs.fi/rss/teasers/etusivu.xml",
    "https://yle.fi/rss/uutiset/paauutiset",
];

let JUNK_THRESHOLD = parseInt(localStorage.getItem("JUNK_THRESHOLD")) || 25;

const ARTICLE_MAX_AGE = 86400;
const RATING_SCORES = [10, 30, 50, 70, 90];
const RATINGS_MAX_COUNT = 200;

function getColumnCount() {
    if (window.innerWidth <  480) return 1;
    if (window.innerWidth <  768) return 2;
    if (window.innerWidth < 1024) return 4;
    return 6;
}

const COLUMN_COUNT = getColumnCount();
document.documentElement.style.setProperty("--column-count", COLUMN_COUNT);

// Pending rating waiting for popover input.
let pendingRating = null;

function connect(target, type, listener) {
    if (typeof target === "string")
        target = document.getElementById(target);
    target.addEventListener(type, listener);
}

function notify(message) {
    let toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.toggle("hidden", false);
    setTimeout(() => toast.classList.toggle("hidden", true), 2000);
}

function setProgress(text) {
    document.getElementById("progress").textContent = text;
}

function showError(message) {
    document.getElementById("busy").classList.toggle("hidden", true);
    const h1 = document.querySelector("h1");
    h1.textContent = message;
    h1.classList.remove("hidden");
}

function parse(texts) {
    setProgress("parsing...");
    // Parse feed texts to a single list of articles.
    return Promise.all(texts.map(text => {
        const parser = new RSSParser();
        return parser.parseString(text)
            .then(feed => feed.items.map(item => ({
                // Strip topic prefixes from titles used at hs.fi.
                // e.g. Lukijan mielipide | Asuntopula hidastaa Helsingin kasvua
                title: (item.title || "").split("|").pop().trim(),
                description: item.contentSnippet || "",
                // Take the first sentence of the description.
                // Avoid stopping at the common case of initials like F. M. Dostoevsky.
                descriptionShort: (item.contentSnippet || "").split(/[^A-ZÅÄÖ][.!?] /)[0],
                url: item.link || "",
                host: new URL(item.link || "").hostname,
                // Take the second last component of host, e.g. www.hs.fi -> hs
                site: new URL(item.link || "").hostname.split(".").slice(-2, -1)[0],
                publishedAt: item.isoDate || "",
            })));
    })).then(results => results.flat());
}

function filterByPublishedAt(articles) {
    return articles.filter(article => {
        const date = new Date(article.publishedAt).getTime();
        return (Date.now() - date) <= ARTICLE_MAX_AGE * 1000;
    });
}

function deduplicate(articles) {
    setProgress("deduplicating...");
    // Deduplicate articles to include only one source per event.
    if (articles.length < 2)
        return Promise.resolve(articles);
    const dump = articles.map((article, i) =>
        `${i}. ${article.title} — ${article.descriptionShort} (${article.host})`
    ).join("\n");
    const prompt = `
You are given a list of news articles.
Identify which articles are about the same news event/story (duplicates).
Return a JSON array of indices to KEEP (one article from each group of duplicates).
Of duplicates, prefer to keep articles from known free public services such as yle.fi.

Articles:
"""
${dump}
"""

Think step by step and briefly state your reasoning.
Then on your final line, return a JSON array of indices to KEEP.
You are not allowed to omit the final JSON array.
Example: [0, 2, 5, 7]
`.trim();
    console.log(prompt);
    const client = new Anthropic({
        apiKey: ANTHROPIC_API_KEY,
        dangerouslyAllowBrowser: true
    });
    return client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 5000,
        messages: [{role: "user", content: prompt}],
    }).then(data => {
        const content = data.content[0].text.trim();
        console.log(content);
        const matches = [...content.matchAll(/\[[\d,\s]+\]/g)];
        const keep = JSON.parse(matches[matches.length-1]);
        return keep.map(i => articles[i]);
    });
}

function getRatings() {
    return JSON.parse(localStorage.getItem("ratings") || "{}");
}

function score(articles) {
    setProgress("scoring...");
    // Assign an importance score (0–100) for each of articles.
    if (articles.length === 0)
        return Promise.resolve(articles);
    const dump = articles.map((article, i) =>
        `${i+1}. ${article.title} — ${article.descriptionShort}`
    ).join("\n");
    const ratings = getRatings();
    const examples = Object.values(ratings).map(x => {
        return `- ${x.title} — ${x.descriptionShort} → ${x.rating} (reason: ${x.ratingReason})`;
    }).join("\n");
    const prompt = `
You are given a list of news articles.
Score the importance of each article with a value between 0–100.
Use the full range 0–100 in about a uniform distribution.
General guidelines and previously rated articles below.
When in conflict, prefer to follow previously rated articles.
Consider not only the topic of articles, but also viewpoint and tone.

General guidelines:
- Favor broad impact (societal, political, economic)
- Favor intellectual curiosity
- Favor promotion of understanding
- Favor insightful commentary (editorials and letters from readers)

Examples of previously rated articles:
"""
${examples}
"""

Articles:
"""
${dump}
"""

First summarize the patterns you see in the previously rated examples.
Then score each article using this exact format (one line per article):
"""
1. brief reasoning → score
2. brief reasoning → score
3. brief reasoning → score
...and so on for all ${articles.length} articles.
"""
You are not allowed to use any other format.
Finally check that you have scored each article.
`.trim();
    console.log(prompt);
    const client = new Anthropic({
        apiKey: ANTHROPIC_API_KEY,
        dangerouslyAllowBrowser: true
    });
    return client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 5000,
        messages: [{role: "user", content: prompt}]
    }).then(data => {
        const content = data.content[0].text.trim();
        console.log(content);
        const scores = [];
        for (const line of content.split("\n")) {
            const match = line.match(/^(\d+)\..+?→\s*(\d+)/);
            if (!match) continue;
            const index = parseInt(match[1]) - 1;
            const score = parseInt(match[2]);
            if (score < 0) continue;
            if (score > 100) continue;
            scores[index] = score;
        }
        return articles.map((article, i) => {
            let score = scores[i];
            if (score === undefined) {
                console.log(`No score for article ${i+1}, using 33`);
                score = 33;
            }
            return {...article, score: score};
        });
    });
}

function showRatingPopover(article, value) {
    pendingRating = {article: article, value: value};
    const popover = document.getElementById("rating-popover");
    const label = document.getElementById("rating-reason-label");
    label.textContent = value > article.score ?
        "what's good about it?" : "what's bad about it?";
    const input = document.getElementById("rating-reason");
    input.value = "";
    popover.showPopover();
    input.focus();
}

function saveRating(article, value, reason) {
    const ratings = getRatings();
    const ratedAt = Math.floor(Date.now() / 1000);
    console.log("Rating", article.url, value, reason);
    ratings[article.url] = {...article, rating: value, ratedAt: ratedAt, ratingReason: reason};
    // Drop oldest ratings if RATINGS_MAX_COUNT exceeded.
    const entries = Object.entries(ratings)
          .sort((a, b) => b[1].ratedAt - a[1].ratedAt)
          .slice(0, RATINGS_MAX_COUNT);

    const filtered = Object.fromEntries(entries);
    localStorage.setItem("ratings", JSON.stringify(filtered));
}

function onRatingSaveClick(event) {
    event.preventDefault();
    if (!pendingRating) return;
    const {article, value} = pendingRating;
    const reason = document.getElementById("rating-reason").value.trim();
    saveRating(article, value, reason);
    document.getElementById("rating-popover").hidePopover();
    notify(`Rated ${article.score} → ${value}`);
    pendingRating = null;
}

function onRatingReasonKeydown(event) {
    event.key === "Enter" && onRatingSaveClick(event);
}

function onPopoverToggle(event) {
    document.body.classList.toggle("popover-open", event.newState === "open");
}

function showConfigPopover(event) {
    event && event.preventDefault();
    const popover = document.getElementById("config-popover");
    document.getElementById("config-key").value = ANTHROPIC_API_KEY || "";
    document.getElementById("config-token").value = PROXY_TOKEN || "";
    document.getElementById("config-feeds").value = FEEDS.join("\n");
    document.getElementById("config-junk-threshold").value = JUNK_THRESHOLD;
    popover.showPopover();
    document.getElementById("config-key").focus();
}

function onConfigSaveClick(event) {
    event.preventDefault();
    const key = document.getElementById("config-key").value.trim();
    const token = document.getElementById("config-token").value.trim();
    const feeds = document.getElementById("config-feeds").value.split("\n").map(x => x.trim()).filter(x => x);
    const junkThreshold = parseInt(document.getElementById("config-junk-threshold").value);
    ANTHROPIC_API_KEY = key;
    PROXY_TOKEN = token;
    FEEDS = feeds;
    JUNK_THRESHOLD = junkThreshold;
    localStorage.setItem("ANTHROPIC_API_KEY", key);
    localStorage.setItem("PROXY_TOKEN", token);
    localStorage.setItem("FEEDS", JSON.stringify(feeds));
    localStorage.setItem("JUNK_THRESHOLD", junkThreshold);
    document.getElementById("config-popover").hidePopover();
    location.reload();
}

function onRatingHover(circles, index) {
    circles.forEach((x, i) => x.classList.toggle("filled", i <= index));
}

function onRatingLeave(circles) {
    circles.forEach(x => x.classList.remove("filled"));
}

function onRatingClick(event, article, rating) {
    event.preventDefault();
    const ratingValue = RATING_SCORES[rating-1];
    showRatingPopover(article, ratingValue);
}

function createRatingCircle(circles, index, article) {
    const circle = document.createElement("span");
    circle.className = "rating-circle";
    circle.addEventListener("mouseenter", () => onRatingHover(circles, index));
    circle.addEventListener("mouseleave", () => onRatingLeave(circles));
    circle.addEventListener("click", event => onRatingClick(event, article, index + 1));
    return circle;
}

function render(articles, grid, muted=false) {
    // Render articles in grid like a newspaper front page.
    grid.innerHTML = "";
    articles.forEach(article => {
        // Map score 0–100 to importance 1–4 and scale based on that.
        const importance = Math.max(1, Math.floor(article.score / 20));
        const size = Math.min(importance, COLUMN_COUNT);
        const cell = document.createElement("div");
        cell.className = "article";
        cell.classList.add(`size-${size}`);
        cell.classList.add(`score-${importance}`);
        if (muted) cell.classList.add("muted");
        const title = document.createElement("h2");
        const link = document.createElement("a");
        link.href = article.url;
        link.referrerPolicy = "no-referrer";
        link.textContent = article.title;
        link.target = "_blank";
        title.appendChild(link);
        const description = document.createElement("p");
        description.className = "description";
        description.textContent = article.description;
        const meta = document.createElement("p");
        meta.className = "meta";
        const date = new Date(article.publishedAt);
        const time = date.toTimeString().slice(0, 5);
        meta.appendChild(document.createTextNode(`${article.site} ${time} → ${article.score} `));
        const rating = document.createElement("span");
        rating.className = "rating";
        const circles = [];
        for (let i = 0; i < 5; i++) {
            const circle = createRatingCircle(circles, i, article);
            circles.push(circle);
            rating.appendChild(circle);
        }
        meta.appendChild(rating);
        cell.appendChild(title);
        cell.appendChild(description);
        cell.appendChild(meta);
        grid.appendChild(cell);
    });
}

function renderAll(articles) {
    setProgress("rendering...");
    console.log("Articles:", articles);
    const visible = articles.filter(x => x.score >= JUNK_THRESHOLD);
    const junkpile = articles.filter(x => x.score < JUNK_THRESHOLD);
    const h1 = document.querySelector("h1");
    h1.textContent = `${visible.length} Articles & ${junkpile.length} Hidden`;
    h1.classList.remove("hidden");
    render(visible, document.getElementById("grid"), false);
    render(junkpile, document.getElementById("junk-grid"), true);
    const toggle = document.getElementById("junk-toggle");
    toggle.classList.toggle("hidden", false);
}

function onJunkToggleClick(event) {
    event.preventDefault();
    const grid = document.getElementById("junk-grid");
    grid.classList.toggle("hidden");
    const link = event.target;
    link.textContent = grid.classList.contains("hidden") ?
        "show junkpile" : "hide junkpile";
}

function onClearCacheClick(event) {
    event.preventDefault();
    sessionStorage.removeItem("articles");
    notify("Cached articles cleared!");
}

function onClearRatingsClick(event) {
    event.preventDefault();
    if (!confirm("Are you sure you want to clear all your ratings?")) return;
    localStorage.removeItem("ratings");
    notify("Ratings cleared!");
}

function getFeedUrl(url) {
    // Use our proxy to get around cross-origin limitations.
    url = encodeURIComponent(url);
    return `${PROXY}?token=${PROXY_TOKEN}&url=${url}`;
}

function loadArticles() {
    const header = document.querySelector("header");
    header.classList.toggle("hidden", true);
    const busy = document.getElementById("busy");
    busy.classList.toggle("hidden", false);
    setProgress("fetching...");
    const feeds = FEEDS.map(getFeedUrl);
    Promise.all(feeds.map(url => fetch(url).then(response => response.text())))
        .then(texts => parse(texts))
        .then(articles => articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)))
        .then(articles => filterByPublishedAt(articles))
        .then(articles => deduplicate(articles))
        .then(articles => score(articles))
        .then(articles => {
            sessionStorage.setItem("articles", JSON.stringify(articles));
            renderAll(articles);
            busy.classList.toggle("hidden", true);
        })
        .catch(error => {
            console.error(error.error);
            const e = error.error.error; // :–|
            showError(`Error ${error.status}: ${e.message}`);
        });
}

function onLoadClick(event) {
    event.preventDefault();
    loadArticles();
}

(function() {
    connect("clear-cache", "click", onClearCacheClick);
    connect("clear-ratings", "click", onClearRatingsClick);
    connect("config-popover", "toggle", onPopoverToggle);
    connect("config-save", "click", onConfigSaveClick);
    connect("edit-settings", "click", showConfigPopover);
    connect("junk-toggle", "click", onJunkToggleClick);
    connect("load", "click", onLoadClick);
    connect("rating-popover", "toggle", onPopoverToggle);
    connect("rating-reason", "keydown", onRatingReasonKeydown);
    connect("rating-save", "click", onRatingSaveClick);
    if (!ANTHROPIC_API_KEY || !PROXY_TOKEN) {
        // Prompt for credentials on first use.
        showConfigPopover();
    } else if (sessionStorage.getItem("articles")) {
        // Render articles from cache.
        const cached = sessionStorage.getItem("articles");
        console.log("Loading articles from cache...");
        const articles = JSON.parse(cached);
        renderAll(articles);
    } else {
        // Show load button.
        const header = document.querySelector("header");
        header.classList.toggle("hidden", false);
    }
})();
