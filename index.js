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

function parse(texts) {
    // Parse feed texts to a single list of articles.
    return Promise.all(texts.map(text => {
        const parser = new RSSParser();
        return parser.parseString(text)
            .then(feed => feed.items.map(item => ({
                title: (item.title || "").split("|").pop().trim(),
                description: item.contentSnippet || "",
                url: item.link || "",
                publishedAt: item.isoDate || "",
            })))
            .catch(error => {
                console.error("Failed to parse feed:", error);
                return [];
            });
    })).then(results => results.flat());
}

function filterByPublishedAt(articles) {
    const now = Date.now();
    return articles.filter(article => {
        const date = new Date(article.publishedAt).getTime();
        return (now - date) <= 24 * 60 * 60 * 1000;
    });
}

function deduplicate(articles) {
    // Deduplicate articles to include only one source per event.
    if (articles.length < 2)
        return Promise.resolve(articles);
    const dump = articles.map((article, i) =>
        `${i}. ${article.title} — ${article.description.slice(0, 100)}`
    ).join("\n");
    const prompt = `
You are given a list of news articles.
Identify which articles are about the same news event/story (duplicates).
Return a JSON array of indices to KEEP (one article from each group of duplicates).
Of duplicates, prefer to keep articles from known free of charge, public services such as yle.fi.

Articles:
${dump}

Return only a JSON array of indices to keep, like: [0, 2, 5, 7]
`.trim();
    console.log(prompt);
    const client = new Anthropic({
        apiKey: ANTHROPIC_API_KEY,
        dangerouslyAllowBrowser: true
    });
    return client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{role: "user", content: prompt}],
    }).then(data => {
        const content = data.content[0].text.trim();
        const keep = JSON.parse(content.match(/\[[\d,\s]+\]/)[0]);
        return keep.map(i => articles[i]);
    });
}

function getVotes() {
    return JSON.parse(localStorage.getItem("votes") || "{}");
}

function score(articles) {
    // Assign an importance score (0–100) for each of articles.
    if (articles.length === 0)
        return Promise.resolve(articles);
    const dump = articles.map((article, i) =>
        `${i}. ${article.title} — ${article.description.slice(0, 100)} (Published: ${article.publishedAt})`
    ).join("\n");
    const votes = getVotes();
    const examples = Object.values(votes).map(vote => {
        const score = vote.vote > 0 ? "HIGH" : "LOW";
        return `- "${vote.title}" → ${score}`;
    }).join("\n");
    const prompt = `
You are given a list of news articles.
Score the importance of each article with a value between 0–100.
Date and time now is ${new Date().toISOString()}.
General guidelines and previously rated articles below.
When in conflict, prefer to follow previously rated articles.
From the previously rated articles, try to infer the general abstract principles.

General guidelines:
- Favor broad impact (societal, political, economic)
- Favor intellectual curiosity
- Favor promotion of understanding
- Favor insightful commentary
- Disfavor petty arguments
- Disfavor empty speculation
- Disfavor moralization
- Disfavor victimization

Examples of previously rated articles:
${examples}

Articles:
${dump}

Return only a JSON array of scores (0–100), one per article in order, like: [85, 72, 91, 45]
`.trim();
    console.log(prompt);
    const client = new Anthropic({
        apiKey: ANTHROPIC_API_KEY,
        dangerouslyAllowBrowser: true
    });
    return client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{role: "user", content: prompt}]
    }).then(data => {
        const content = data.content[0].text.trim();
        const scores = JSON.parse(content.match(/\[[\d,\s]+\]/)[0]);
        return articles.map((feed, i) => ({...feed, score: scores[i] || 50}));
    });
}

function saveVote(article, value) {
    const votes = getVotes();
    const votedAt = Math.floor(Date.now() / 1000);
    console.log("Voting", article.url, value);
    votes[article.url] = {title: article.title, vote: value, votedAt: votedAt};
    // Keep only latest 100 votes.
    const entries = Object.entries(votes)
          .sort((a, b) => b[1].votedAt - a[1].votedAt)
          .slice(0, 100);
    const filtered = Object.fromEntries(entries);
    localStorage.setItem("votes", JSON.stringify(filtered));
}

function upVote(event, article) {
    event.preventDefault();
    saveVote(article, 1);
}

function downVote(event, article) {
    event.preventDefault();
    saveVote(article, -1);
}

function render(articles) {
    // Render articles in grid like a newspaper front page.
    const grid = document.getElementById("grid");
    grid.innerHTML = "";
    articles.forEach(article => {
        // Map score 0–100 to size 1–4 (column span).
        const size = Math.ceil(article.score / 25);
        const cell = document.createElement("div");
        cell.className = "article";
        cell.classList.add(`size-${size}`);
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
        upButton.addEventListener("click", (event) => upVote(event, article));
        const downButton = document.createElement("a");
        downButton.href = "#";
        downButton.role = "button";
        downButton.textContent = "▼";
        downButton.addEventListener("click", (event) => downVote(event, article));
        const site = new URL(article.url).hostname.split(".").slice(-2, -1)[0];
        const date = new Date(article.publishedAt);
        const day = date.getDate();
        const monthNames = ["tammi", "helmi", "maalis", "huhti", "touko", "kesä", "heinä", "elo", "syys", "loka", "marras", "joulu"];
        const month = monthNames[date.getMonth()];
        const time = date.toTimeString().slice(0, 5);
        meta.appendChild(upButton);
        meta.appendChild(document.createTextNode(` ${site} — ${day}. ${month} ${time} `));
        meta.appendChild(downButton);
        cell.appendChild(title);
        cell.appendChild(description);
        cell.appendChild(meta);
        grid.appendChild(cell);
    });
}

function getFeedUrl(url) {
    // Use our proxy to get around cross-origin limitations.
    url = encodeURIComponent(url);
    return `${PROXY}?token=${PROXY_TOKEN}&url=${url}`;
}

function main() {
    // XXX: Cache in session storage while we're mostly just testing.
    const cached = sessionStorage.getItem("articles");
    if (cached) {
        console.log("Loading articles from cache...");
        const articles = JSON.parse(cached);
        console.log(articles);
        render(articles);
    } else {
        const busy = document.getElementById("busy");
        busy.classList.toggle("hidden", false);
        const feeds = FEEDS.map(getFeedUrl);
        Promise.all(feeds.map(url => fetch(url).then(response => response.text())))
            .then(texts => parse(texts))
            .then(articles => filterByPublishedAt(articles))
            .then(articles => deduplicate(articles))
            .then(articles => score(articles))
            .then(articles => {
                articles = articles.filter(article => article.score >= 10);
                articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
                articles = articles.slice(0, 100);
                sessionStorage.setItem("articles", JSON.stringify(articles));
                console.log(articles);
                render(articles);
                busy.classList.toggle("hidden", true);
            });
    }
}

(function() {
    main();
})();
