# Orbit webmail image: the official Roundcube image plus the orbit_bridge plugin,
# the orbit skin and the hardening configuration. Roundcube runs as www-data.
FROM roundcube/roundcubemail:1.7.6-apache-nonroot@sha256:6f3d54d5275bd843852bd2c7628988faa05d5c6ec33529a6fc9744ef20596c87

USER root

# The entrypoint copies /usr/src/roundcubemail into the docroot volume on first start,
# so plugin and skin must live in the source tree, not in /var/www/html.
COPY plugins/orbit_bridge /usr/src/roundcubemail/plugins/orbit_bridge
COPY skins/orbit /usr/src/roundcubemail/skins/orbit

# The entrypoint includes /var/roundcube/config/*.php last, so these values win.
COPY config/orbit.inc.php /var/roundcube/config/orbit.inc.php
COPY config/apache-orbit.conf /etc/apache2/conf-available/orbit.conf

# Remove everything a request must never reach, then enable the header module and our vhost settings.
RUN rm -f /usr/src/roundcubemail/public_html/installer.php \
    && rm -rf /usr/src/roundcubemail/installer \
    && a2enmod -q headers \
    && a2enconf -q orbit \
    && a2disconf -q serve-cgi-bin

USER 33:33
