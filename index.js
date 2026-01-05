// -*- coding: utf-8-unix -*-

import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.71.2/+esm';

const PARAMS = new URLSearchParams(window.location.search);

const FEEDS = [
    "https://feeds.kauppalehti.fi/rss/main",
    "https://www.hs.fi/rss/teasers/etusivu.xml",
    "https://yle.fi/rss/uutiset/paauutiset",
];

const ANTHROPIC_API_KEY = PARAMS.get("key");
const PROXY_TOKEN = PARAMS.get("token");
const PROXY = "https://ep3tfancwtwxecots3p6txr3ka0xfcrr.lambda-url.eu-north-1.on.aws/";

function parse(feedTexts) {
    const parser = new RSSParser();
    const promises = feedTexts.map(feedText =>
        parser.parseString(feedText)
            .then(feed => feed.items.map(item => ({
                title: (item.title || "").split("|").pop().trim(),
                description: item.contentSnippet || item.description || "",
                url: item.link || "",
                publishedAt: item.isoDate || item.pubDate || "",
            })))
            .catch(error => {
                console.error("Failed to parse feed:", error);
                return [];
            })
    );
    return Promise.all(promises).then(results => results.flat());
}

function deduplicate(feeds) {
    if (feeds.length === 0) return Promise.resolve(feeds);
    if (!ANTHROPIC_API_KEY) {
        console.warn("No Anthropic API key provided, skipping deduplication");
        return Promise.resolve(feeds);
    }
    const prompt = `You are given a list of news articles. Identify which articles are about the same news story (duplicates). Return a JSON array of indices to KEEP (one random article from each group of duplicates).

Articles:
${feeds.map((feed, idx) => `${idx}. "${feed.title}" - ${feed.description.slice(0, 100)}`).join("\n")}

Return only a JSON array of indices to keep, like: [0, 2, 5, 7]`;

    const client = new Anthropic({
        apiKey: ANTHROPIC_API_KEY,
        dangerouslyAllowBrowser: true
    });

    return client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{
            role: "user",
            content: prompt
        }]
    })
        .then(data => {
            const content = data.content[0].text.trim();
            const indicesToKeep = JSON.parse(content.match(/\[[\d,\s]+\]/)[0]);
            return indicesToKeep.map(idx => feeds[idx]);
        })
        .catch(error => {
            console.error("Deduplication failed:", error);
            return feeds;
        });
}

function score(feeds) {
    if (feeds.length === 0) return Promise.resolve(feeds);
    if (!ANTHROPIC_API_KEY) {
        console.warn("No Anthropic API key provided, skipping scoring");
        return Promise.resolve(feeds);
    }
    const prompt = `You are given a list of news articles. Score each article from 0-100 based on:
1. Broad significance of the event (impact on society, economy, politics, etc.)
2. Recency (newer articles score higher)

Articles:
${feeds.map((feed, idx) => `${idx}. "${feed.title}" - ${feed.description.slice(0, 100)} (Published: ${feed.publishedAt})`).join("\n")}

Return only a JSON array of scores (0-100), one per article in order, like: [85, 72, 91, 45]`;

    const client = new Anthropic({
        apiKey: ANTHROPIC_API_KEY,
        dangerouslyAllowBrowser: true
    });

    return client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{
            role: "user",
            content: prompt
        }]
    })
        .then(data => {
            const content = data.content[0].text.trim();
            const scores = JSON.parse(content.match(/\[[\d,\s]+\]/)[0]);
            return feeds.map((feed, idx) => ({
                ...feed,
                score: scores[idx] || 0
            }));
        })
        .catch(error => {
            console.error("Scoring failed:", error);
            return feeds.map(feed => ({ ...feed, score: 50 }));
        });
}

function render(feeds) {
    const grid = document.getElementById("grid");
    grid.innerHTML = "";

    feeds.forEach(feed => {
        let sizeClass = "size-1";
        if (feed.score >= 80) sizeClass = "size-4";
        else if (feed.score >= 60) sizeClass = "size-3";
        else if (feed.score >= 40) sizeClass = "size-2";


        const article = document.createElement("div");
        article.className = "article";
        article.classList.add(sizeClass);

        // Determine font size based on score
        let fontSize = "1em";
        if (feed.score >= 80) fontSize = "2.4em";
        else if (feed.score >= 60) fontSize = "1.8em";
        else if (feed.score >= 40) fontSize = "1.4em";

        const title = document.createElement("h2");
        title.style.fontSize = fontSize;
        title.style.lineHeight = 1.25;
        const link = document.createElement("a");
        link.href = feed.url;
        link.textContent = feed.title;
        link.target = "_blank";
        title.appendChild(link);

        const description = document.createElement("p");
        description.textContent = feed.description;

        const meta = document.createElement("p");
        meta.className = "meta";
        const domain = new URL(feed.url).hostname.replace(/^www\./, "");
        const date = new Date(feed.publishedAt);
        const day = date.getDate();
        const ordinal = ["th", "st", "nd", "rd"][(day % 10 > 3 || Math.floor(day / 10) === 1) ? 0 : day % 10];
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        meta.textContent = `${domain} ${day}${ordinal} ${monthNames[date.getMonth()]} ${hours}:${minutes}`;

        article.appendChild(title);
        article.appendChild(description);
        article.appendChild(meta);
        grid.appendChild(article);
    });
}

function main(feedTexts) {
    parse(feedTexts)
        .then(feeds => deduplicate(feeds))
        .then(feeds => score(feeds))
        .then(feeds => {
            feeds.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
            const topFeeds = feeds.slice(0, 40);
            console.log(topFeeds);
            sessionStorage.setItem('processedFeeds', JSON.stringify(topFeeds));
            render(topFeeds);
        });
}

function getFeedUrl(url) {
    url = encodeURIComponent(url);
    return `${PROXY}?token=${PROXY_TOKEN}&url=${url}`;
}

(function() {
    const cached = sessionStorage.getItem('processedFeeds');
    if (cached) {
        try {
            const topFeeds = JSON.parse(cached);
            console.log('Loaded from cache:', topFeeds);
            render(topFeeds);
            return;
        } catch (error) {
            console.error('Failed to parse cached feeds:', error);
            sessionStorage.removeItem('processedFeeds');
        }
    }
    const feeds = FEEDS.map(getFeedUrl);
    Promise.all(feeds.map(url =>
        fetch(url).then(res => res.text())
    )).then(feedTexts => main(feedTexts));
})();
