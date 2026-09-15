// -*- coding: utf-8-unix -*-

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.71.2/+esm";

const PARAMS = new URLSearchParams(window.location.search);

// Load needed key and token from URL parameters or local storage.
const ANTHROPIC_API_KEY = PARAMS.get("key") || localStorage.getItem("news_rss_anthropic_api_key");
let PROXY_TOKEN = PARAMS.get("token") || localStorage.getItem("news_rss_proxy_token");

let PROXY = "https://ep3tfancwtwxecots3p6txr3ka0xfcrr.lambda-url.eu-north-1.on.aws/";
if (PARAMS.get("proxy-local")) {
    PROXY = "http://localhost:8001/";
    PROXY_TOKEN = "not-needed-locally";
}
console.log(`Using proxy ${PROXY}`);

const FEEDS = JSON.parse(localStorage.getItem("news_rss_feeds")) || [
    "https://www.hs.fi/rss/teasers/etusivu.xml",
    "https://yle.fi/rss/uutiset/paauutiset",
];

const JUNK_THRESHOLD = parseInt(localStorage.getItem("news_rss_junk_threshold")) || 25;

const MODEL = "claude-opus-5";
console.log(`Using model ${MODEL}`);

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

function connect(id, type, listener) {
    document.getElementById(id).addEventListener(type, listener);
}

function notify(message) {
    let toast = document.getElementById("toast");
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2000);
}

function setProgress(text) {
    document.getElementById("progress").textContent = text;
}

function showError(message) {
    document.getElementById("busy").hidden = true;
    const h1 = document.querySelector("h1");
    h1.textContent = message;
    h1.hidden = false;
}

function parse(texts) {
    setProgress("parsing...");
    // Parse feed texts to a single list of articles.
    return Promise.all(texts.map(text => new RSSParser().parseString(text)))
        .then(feeds => feeds.flatMap(feed => feed.items.map(item => {
            const description = item.contentSnippet || "";
            const host = new URL(item.link).hostname;
            return {
                // Strip topic prefixes from titles used at hs.fi.
                // e.g. Lukijan mielipide | Asuntopula hidastaa Helsingin kasvua
                title: (item.title || "").split("|").pop().trim(),
                description: description,
                // Take the first sentence of the description.
                // Avoid stopping at the common case of initials like F. M. Dostoevsky.
                descriptionShort: description.split(/[^A-ZÅÄÖ][.!?] /)[0],
                url: item.link,
                host: host,
                // Take the second last component of host, e.g. www.hs.fi -> hs
                site: host.split(".").slice(-2, -1)[0],
                publishedAt: item.isoDate || "",
            };
        })));
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
        model: MODEL,
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
    return JSON.parse(localStorage.getItem("news_rss_ratings") || "{}");
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
        model: MODEL,
        max_tokens: 5000,
        messages: [{role: "user", content: prompt}]
    }).then(data => {
        const content = data.content[0].text.trim();
        console.log(content);
        const scores = [];
        for (const line of content.split("\n")) {
            const match = line.match(/^(\d+)\..+?→\s*(\d+)/);
            if (!match) continue;
            const value = parseInt(match[2]);
            if (value > 100) continue;
            scores[parseInt(match[1]) - 1] = value;
        }
        return articles.map((article, i) => {
            if (scores[i] === undefined)
                console.log(`No score for article ${i+1}, using 33`);
            return {...article, score: scores[i] ?? 33};
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

function onRatingSaveClick(event) {
    event.preventDefault();
    const {article, value} = pendingRating;
    const reason = document.getElementById("rating-reason").value.trim();
    console.log("Rating", article.url, value, reason);
    const ratings = getRatings();
    const ratedAt = Math.floor(Date.now() / 1000);
    ratings[article.url] = {...article, rating: value, ratedAt: ratedAt, ratingReason: reason};
    // Keep only the newest 200 ratings.
    const newest = Object.entries(ratings)
          .sort((a, b) => b[1].ratedAt - a[1].ratedAt)
          .slice(0, 200);
    localStorage.setItem("news_rss_ratings", JSON.stringify(Object.fromEntries(newest)));
    document.getElementById("rating-popover").hidePopover();
    notify(`Rated ${article.score} → ${value}`);
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
    localStorage.setItem("news_rss_anthropic_api_key", key);
    localStorage.setItem("news_rss_proxy_token", token);
    localStorage.setItem("news_rss_feeds", JSON.stringify(feeds));
    localStorage.setItem("news_rss_junk_threshold", junkThreshold);
    window.location.reload();
}

function render(articles, grid) {
    // Render articles in grid like a newspaper front page.
    grid.replaceChildren();
    articles.forEach(article => {
        // Map score 0–100 to importance 1–4 and scale based on that.
        const importance = Math.max(1, Math.min(4, Math.floor(article.score / 20)));
        const size = Math.min(importance, COLUMN_COUNT);
        const cell = document.createElement("div");
        cell.className = `article size-${size} importance-${importance}`;
        const title = document.createElement("h2");
        const link = document.createElement("a");
        link.href = article.url;
        link.referrerPolicy = "no-referrer";
        link.textContent = article.title;
        link.target = "_blank";
        title.append(link);
        const description = document.createElement("p");
        description.className = "description";
        description.textContent = article.description;
        const meta = document.createElement("p");
        meta.className = "meta";
        const time = new Date(article.publishedAt).toTimeString().slice(0, 5);
        const rating = document.createElement("span");
        rating.className = "rating";
        [10, 30, 50, 70, 90].forEach(value => {
            const circle = document.createElement("span");
            circle.className = "rating-circle";
            circle.addEventListener("click", () => showRatingPopover(article, value));
            rating.append(circle);
        });
        meta.append(`${article.site} ${time} → ${article.score} `, rating);
        cell.append(title, description, meta);
        grid.append(cell);
    });
}

function renderAll(articles) {
    setProgress("rendering...");
    console.log("Articles:", articles);
    const visible = articles.filter(x => x.score > JUNK_THRESHOLD);
    const junkpile = articles.filter(x => x.score <= JUNK_THRESHOLD);
    const h1 = document.querySelector("h1");
    h1.textContent = `${visible.length} Articles & ${junkpile.length} Hidden`;
    h1.hidden = false;
    render(visible, document.getElementById("grid"));
    render(junkpile, document.getElementById("junk-grid"));
    document.getElementById("junk-toggle").hidden = false;
}

function onJunkToggleClick(event) {
    event.preventDefault();
    const grid = document.getElementById("junk-grid");
    grid.hidden = !grid.hidden;
    event.target.textContent = grid.hidden ? "show junkpile" : "hide junkpile";
}

function onClearCacheClick(event) {
    event.preventDefault();
    sessionStorage.removeItem("articles");
    notify("Cached articles cleared!");
}

function onClearRatingsClick(event) {
    event.preventDefault();
    if (!confirm("Are you sure you want to clear all your ratings?")) return;
    localStorage.removeItem("news_rss_ratings");
    notify("Ratings cleared!");
}

function onLoadClick(event) {
    event.preventDefault();
    document.querySelector("header").hidden = true;
    const busy = document.getElementById("busy");
    busy.hidden = false;
    setProgress("fetching...");
    // Use our proxy to get around cross-origin limitations.
    const urls = FEEDS.map(url => `${PROXY}?token=${PROXY_TOKEN}&url=${encodeURIComponent(url)}`);
    Promise.all(urls.map(url => fetch(url).then(response => response.text())))
        .then(parse)
        // Keep articles from the last 24 hours, newest first.
        .then(articles => articles
              .filter(x => Date.now() - new Date(x.publishedAt) <= 86400 * 1000)
              .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)))
        .then(deduplicate)
        .then(score)
        .then(articles => {
            sessionStorage.setItem("articles", JSON.stringify(articles));
            renderAll(articles);
            busy.hidden = true;
        })
        .catch(error => {
            console.error(error.error);
            const e = error.error.error; // :–|
            showError(`Error ${error.status}: ${e.message}`);
        });
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
        document.querySelector("header").hidden = false;
    }
})();
