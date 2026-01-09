#!/usr/bin/env python3

import os
import requests
import sys

HEADERS = {"Content-Type": "text/plain", "Cache-Control": "max-age=600"}
TOKEN = os.environ["TOKEN"]

def download(url):
    response = requests.get(url, timeout=10)
    return response.text.strip() if response.ok else ""

def response(status_code, body):
    return {"statusCode": status_code, "headers": HEADERS, "body": body}

def lambda_handler(event, context):
    params = event.get("queryStringParameters", {})
    if params.get("token") != TOKEN:
        return response(400, "What are you doing?")
    if not (url := params.get("url")):
        return response(400, f"Bad {url=}")
    return response(200, download(url))

if __name__ == "__main__":
    print(download(sys.argv[1]))
