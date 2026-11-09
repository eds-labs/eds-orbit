# Orbit webmail image: the official Roundcube image with the orbit_bridge plugin, the
# orbit skin and the hardening configuration baked in. Roundcube runs as www-data on a
# read-only filesystem and needs no network at start beyond its database.
FROM roundcube/roundcubemail:1.7.6-apache-nonroot@sha256:6f3d54d5275bd843852bd2c7628988faa05d5c6ec33529a6fc9744ef20596c87 AS upstream

# Compiles the skin from Elastic's LESS sources at the pinned version, so a Roundcube
# update rebuilds it against the new Elastic instead of a stale copy.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS skin
WORKDIR /build
COPY skin-build/package.json skin-build/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
COPY --from=upstream /usr/src/roundcubemail/skins/elastic skins/elastic
COPY skins/orbit skins/orbit
COPY skin-build/compile.sh ./
RUN ./compile.sh

FROM upstream
USER root

# The code lives directly in the docroot, owned by root, so a compromised PHP process
# cannot change it even if the read-only mount were removed.
COPY plugins/orbit_bridge /usr/src/roundcubemail/plugins/orbit_bridge
COPY --from=skin /build/skins/orbit /usr/src/roundcubemail/skins/orbit
COPY config/orbit.inc.php /usr/src/roundcubemail/config/config.inc.php
COPY config/apache-orbit.conf /etc/apache2/conf-available/orbit.conf
COPY entrypoint.sh /usr/local/bin/orbit-webmail-entrypoint

WORKDIR /
RUN rm -f /usr/src/roundcubemail/public_html/installer.php \
    && rm -rf /usr/src/roundcubemail/installer /var/www/html \
    && mv /usr/src/roundcubemail /var/www/html \
    && chown -R root:root /var/www/html \
    && chmod -R go-w /var/www/html \
    && rm -f /usr/local/bin/composer /docker-entrypoint.sh \
    && a2enmod -q headers \
    && a2enconf -q orbit \
    && a2disconf -q serve-cgi-bin

# Everything Apache writes goes to the /tmp tmpfs. Its logs are symlinks to stdout.
ENV APACHE_RUN_DIR=/tmp/apache2/run \
    APACHE_PID_FILE=/tmp/apache2/run/apache2.pid \
    APACHE_LOCK_DIR=/tmp/apache2/lock

WORKDIR /var/www/html
USER 33:33
ENTRYPOINT ["/usr/local/bin/orbit-webmail-entrypoint"]
CMD ["apache2-foreground"]
