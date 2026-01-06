// -*- coding: utf-8-unix -*-

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.71.2/+esm";

const PARAMS = new URLSearchParams(window.location.search);
const ANTHROPIC_API_KEY = PARAMS.get("key") || sessionStorage.getItem("key") || null;
const PROXY = "https://ep3tfancwtwxecots3p6txr3ka0xfcrr.lambda-url.eu-north-1.on.aws/";
const PROXY_TOKEN = PARAMS.get("token") || sessionStorage.getItem("token") || null;

if (!ANTHROPIC_API_KEY) throw "Missing ANTHROPIC_API_KEY!";
if (!PROXY_TOKEN) throw "Missing PROXY_TOKEN!";

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

function score(articles) {
    // Assign an importance score (0–100) for each of articles.
    if (articles.length === 0)
        return Promise.resolve(articles);
    const dump = articles.map((article, i) =>
        `${i}. ${article.title} — ${article.description.slice(0, 100)} (Published: ${article.publishedAt})`
    ).join("\n");
    const prompt = `
You are given a list of news articles.
Score the importance of each article with a value between 0–100.
Date and time now is ${new Date().toISOString()}.

General guidelines:
- Favor broad impact (societal, political, economic)
- Favor intellectual curiosity
- Favor promotion of understanding
- Favor insightful commentary
- Disfavor petty arguments
- Disfavor empty speculation
- Disfavor moralization
- Disfavor victimization

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
        const site = new URL(article.url).hostname.split(".").slice(-2, -1)[0];
        const date = new Date(article.publishedAt);
        const day = date.getDate();
        const monthNames = ["tammi", "helmi", "maalis", "huhti", "touko", "kesä", "heinä", "elo", "syys", "loka", "marras", "joulu"];
        const month = monthNames[date.getMonth()];
        const time = date.toTimeString().slice(0, 5);
        meta.textContent = `${site} — ${day}. ${month} ${time}`;
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
        const feeds = FEEDS.map(getFeedUrl);
        Promise.all(feeds.map(url => fetch(url).then(response => response.text())))
            .then(texts => parse(texts))
            .then(articles => deduplicate(articles))
            .then(articles => score(articles))
            .then(articles => {
                articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
                sessionStorage.setItem("articles", JSON.stringify(articles));
                console.log(articles);
                render(articles);
            });
    }
}

(function() {
    main();
})();
