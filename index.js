// -*- coding: utf-8-unix -*-

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.71.2/+esm";

const PARAMS = new URLSearchParams(window.location.search);
const PROXY = "https://ep3tfancwtwxecots3p6txr3ka0xfcrr.lambda-url.eu-north-1.on.aws/";

// Load needed key and token from URL parameters or local storage or prompt.
let ANTHROPIC_API_KEY = PARAMS.get("key") || localStorage.getItem("ANTHROPIC_API_KEY");
let PROXY_TOKEN = PARAMS.get("token") || localStorage.getItem("PROXY_TOKEN");

if (!ANTHROPIC_API_KEY) {
    const response = prompt("Anthropic API key:");
    if (!response) throw "Missing ANTHROPIC_API_KEY!";
    ANTHROPIC_API_KEY = response;
    localStorage.setItem("ANTHROPIC_API_KEY", response);
}

if (!PROXY_TOKEN) {
    const response = prompt("Proxy token:");
    if (!response) throw "Missing PROXY_TOKEN!";
    PROXY_TOKEN = response;
    localStorage.setItem("PROXY_TOKEN", response);
}

const FEEDS = [
    "https://feeds.kauppalehti.fi/rss/main",
    "https://www.hs.fi/rss/teasers/etusivu.xml",
    "https://yle.fi/rss/uutiset/paauutiset",
];

// TODO: Allow override by URL parameters.
const ARTICLE_MAX_AGE = 86400;
const VOTES_MAX_COUNT = 500;

function parse(texts) {
    // Parse feed texts to a single list of articles.
    return Promise.all(texts.map(text => {
        const parser = new RSSParser();
        return parser.parseString(text)
            .then(feed => feed.items.map(item => ({
                title: (item.title || "").split("|").pop().trim(),
                description: item.contentSnippet || "",
                descriptionShort: (item.contentSnippet || "").split(/[^A-ZÅÄÖ][.!?] /)[0],
                url: item.link || "",
                host: new URL(item.link || "").hostname,
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
${dump}

THINK STEP BY STEP AND BRIEFLY STATE YOUR REASONING.
THEN ON YOUR FINAL LINE, RETURN A JSON ARRAY OF INDICES TO KEEP.
YOU ARE NOT ALLOWED TO OMIT THE FINAL JSON ARRAY.
EXAMPLE: [0, 2, 5, 7]
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

function getVotes() {
    return JSON.parse(localStorage.getItem("votes") || "{}");
}

function notify(message) {
    let toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.toggle("hidden", false);
    setTimeout(() => toast.classList.toggle("hidden", true), 2000);
}

function score(articles) {
    // Assign an importance score (0–100) for each of articles.
    if (articles.length === 0)
        return Promise.resolve(articles);
    const dump = articles.map((article, i) =>
        `${i}. ${article.title} — ${article.descriptionShort}`
    ).join("\n");
    const votes = getVotes();
    const examples = Object.values(votes).map(vote => {
        const score = vote.vote > 0 ? 90 : 10;
        return `- ${vote.title} — ${vote.descriptionShort} → ${score}`;
    }).join("\n");
    const prompt = `
You are given a list of news articles.
Score the importance of each article with a value between 0–100.
Use the full range 0–100 in about a uniform distribution.
General guidelines and previously rated articles below.
When in conflict, prefer to follow previously rated articles.
From the previously rated articles, try to infer the general abstract principles.
Consider not only the topic of articles, but also viewpoint and tone.

General guidelines:
- Favor broad impact (societal, political, economic)
- Favor intellectual curiosity
- Favor promotion of understanding
- Favor insightful commentary (editorials and letters from readers)

Examples of previously rated articles:
${examples}

Articles:
${dump}

THINK STEP BY STEP AND BRIEFLY STATE YOUR REASONING.
THEN ON YOUR FINAL LINE, RETURN A JSON ARRAY OF SCORES (0–100), ONE PER ARTICLE IN ORDER.
YOU ARE NOT ALLOWED TO OMIT THE FINAL JSON ARRAY.
EXAMPLE: [85, 17, 53, 41]
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
        const matches = [...content.matchAll(/\[[\d,\s]+\]/g)];
        const scores = JSON.parse(matches[matches.length-1]);
        return articles.map((feed, i) => ({...feed, score: scores[i] || 50}));
    });
}

function saveVote(article, value) {
    const votes = getVotes();
    const votedAt = Math.floor(Date.now() / 1000);
    console.log("Voting", article.url, value);
    votes[article.url] = {...article, vote: value, votedAt: votedAt};
    // Drop the oldest votes to if VOTES_MAX_COUNT exceeded.
    const entries = Object.entries(votes)
          .sort((a, b) => b[1].votedAt - a[1].votedAt)
          .slice(0, VOTES_MAX_COUNT);

    const filtered = Object.fromEntries(entries);
    localStorage.setItem("votes", JSON.stringify(filtered));
}

function upVote(event, article) {
    event.preventDefault();
    saveVote(article, 1);
    notify(`Upvoted “${article.title}”`);
}

function downVote(event, article) {
    event.preventDefault();
    saveVote(article, -1);
    notify(`Downvoted “${article.title}”`);
}

function render(articles, grid, muted=false) {
    // Render articles in grid like a newspaper front page.
    grid.innerHTML = "";
    articles.forEach(article => {
        // Map score 0–100 to size 1–4 (column span).
        const size = Math.max(1, Math.floor(article.score / 20));
        const cell = document.createElement("div");
        cell.className = "article";
        cell.classList.add(`size-${size}`);
        if (muted) cell.classList.add("muted");
        const title = document.createElement("h2");
        const link = document.createElement("a");
        link.href = article.url;
        link.textContent = article.title;
        link.target = "_blank";
        title.appendChild(link);
        const description = document.createElement("p");
        description.className = "description";
        description.textContent = article.description;
        const meta = document.createElement("p");
        meta.className = "meta";
        const upButton = document.createElement("a");
        upButton.href = "#";
        upButton.role = "button";
        upButton.textContent = "▲";
        upButton.addEventListener("click", event => upVote(event, article));
        const downButton = document.createElement("a");
        downButton.href = "#";
        downButton.role = "button";
        downButton.textContent = "▼";
        downButton.addEventListener("click", event => downVote(event, article));
        const date = new Date(article.publishedAt);
        const time = date.toTimeString().slice(0, 5);
        meta.appendChild(upButton);
        meta.appendChild(document.createTextNode(` ${article.site} ${time} → ${article.score}`));
        meta.appendChild(downButton);
        cell.appendChild(title);
        cell.appendChild(description);
        cell.appendChild(meta);
        grid.appendChild(cell);
    });
}

function renderAll(articles) {
    const visible = articles.filter(a => a.score >= 20);
    const junkpile = articles.filter(a => a.score < 20);
    render(visible, document.getElementById("grid"), false);
    render(junkpile, document.getElementById("junk-grid"), true);
    const toggle = document.getElementById("toggle-junk");
    toggle.classList.toggle("hidden", false);
}

function getFeedUrl(url) {
    // Use our proxy to get around cross-origin limitations.
    url = encodeURIComponent(url);
    return `${PROXY}?token=${PROXY_TOKEN}&url=${url}`;
}

function toggleJunk(event) {
    event.preventDefault();
    const grid = document.getElementById("junk-grid");
    const link = event.target;
    grid.classList.toggle("hidden");
    link.textContent = grid.classList.contains("hidden") ? "show junkpile" : "hide junkpile";
}

function main() {
    document.getElementById("toggle-junk").addEventListener("click", event => toggleJunk(event));
    // XXX: Cache in session storage while we're mostly just testing.
    const cached = sessionStorage.getItem("articles");
    if (cached) {
        console.log("Loading articles from cache...");
        const articles = JSON.parse(cached);
        console.log(articles);
        renderAll(articles);
    } else {
        const busy = document.getElementById("busy");
        busy.classList.toggle("hidden", false);
        const feeds = FEEDS.map(getFeedUrl);
        Promise.all(feeds.map(url => fetch(url).then(response => response.text())))
            .then(texts => parse(texts))
            .then(articles => articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)))
            .then(articles => filterByPublishedAt(articles))
            .then(articles => deduplicate(articles))
            .then(articles => score(articles))
            .then(articles => {
                sessionStorage.setItem("articles", JSON.stringify(articles));
                console.log(articles);
                renderAll(articles);
                busy.classList.toggle("hidden", true);
            });
    }
}

(function() {
    main();
})();
