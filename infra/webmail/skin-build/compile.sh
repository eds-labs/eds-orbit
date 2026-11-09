#!/bin/sh
# Compiles the orbit skin the same way Elastic's own Makefile does. URLs are rewritten
# so the fonts and images Elastic ships resolve from the skins/orbit/styles directory.
set -eu

# Roundcube resolves a template's assets against the skin that owns the template, so an
# inherited layout would link Elastic's stylesheet. An unchanged copy links this one.
cp skins/elastic/templates/includes/layout.html skins/orbit/templates/includes/layout.html

cd skins/orbit/styles

for sheet in styles print embed; do
    ../../../node_modules/.bin/lessc --rewrite-urls=all --clean-css="--s1 --advanced" "$sheet.less" > "$sheet.min.css"
done

rm -f ./*.less
