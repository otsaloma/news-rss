# -*- coding: utf-8-unix -*-

VERSION = `date +%s`

check:
	uv run flake8 *.py
	oxlint --deny-warnings *.js

clean:
	rm -rf html
	rm -rf lambda
	rm -f lambda.zip
	rm -f requirements-lambda.txt

# https://docs.aws.amazon.com/lambda/latest/dg/python-package.html
# https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html#runtimes-supported
# https://aws.amazon.com/premiumsupport/knowledge-center/lambda-python-package-compatible/
dist-lambda:
	$(MAKE) check clean
	uv export \
	--no-dev \
	--no-emit-project \
	--output-file requirements-lambda.txt
	uv pip install \
	--python-platform x86_64-manylinux_2_34 \
	--python-version 3.12 \
	--target lambda \
	--only-binary :all: \
	-r requirements-lambda.txt
	rm -rf lambda/bin
	find lambda -name "__pycache__" -prune -exec rm -rf {} \;
	cp proxy.py lambda
	cd lambda && zip -r ../lambda.zip .

deploy-lambda:
	$(MAKE) dist-lambda
	test -f lambda.zip
	aws lambda update-function-code \
	--region eu-north-1 \
	--function-name news-rss-proxy \
	--zip-file fileb://lambda.zip

dist-html:
	$(MAKE) check clean
	mkdir html
	cp *.css *.html *.js *.png *.svg html
	cp fonts/*.otf html
	sed -ri "s|fonts/||g" html/*.css
	sed -ri "s|\?v=dev\"|?v=$(VERSION)\"|g" html/*.html
	! grep "?v=dev" html/*.html
	./bundle-assets.py html/*.html
	rm html/*.css html/*.js

deploy-html:
	$(MAKE) dist-html
	@echo "Uploading HTML files..."
	aws s3 sync html/ s3://otsaloma.io/news/ \
	--exclude "*" \
	--include "*.html" \
	--acl public-read \
	--cache-control "public, max-age=3600"
	@echo "Uploading everything else..."
	aws s3 sync html/ s3://otsaloma.io/news/ \
	--exclude "*.html" \
	--acl public-read \
	--cache-control "public, max-age=86400"

run:
	uv run python -m http.server

run-proxy:
	uv run python proxy-local.py

.PHONY: check clean dist-lambda deploy-lambda dist-html deploy-html run run-proxy
