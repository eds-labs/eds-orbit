/* Orbit bridge: the browser side of the embedding, loaded on every Roundcube page. */
(function () {
    var CONVERT_COMMAND = 'plugin.orbit_bridge.convert';
    var REFERENCE_ACTION = 'plugin.orbit_bridge.convert_reference';
    var REFERENCE_FAILED_ACTION = 'plugin.orbit_bridge.convert_failed';
    var SESSION_LOST_EVENT = 'plugin.orbit_bridge.session_lost';

    var sessionLostReported = false;
    var orbitTab = null;
    var enableCommand = rcmail.enable_command;

    function isDisabled(command) {
        return (rcmail.env.orbit_disabled_commands || []).indexOf(command) !== -1;
    }

    // Roundcube re-enables commands on every selection change, so the filter has to sit
    // in front of enable_command. It only hides what the server refuses anyway.
    rcmail.enable_command = function () {
        var args = Array.prototype.slice.call(arguments);
        var enabled = args.pop();
        var commands = [];

        args.forEach(function (entry) {
            commands = commands.concat(entry);
        });

        return enableCommand.apply(this, (enabled ? commands.filter(function (command) {
            return !isDisabled(command);
        }) : commands).concat(enabled));
    };

    function isEmbedded() {
        return !!window.orbitParent;
    }

    function postToOrbit(message) {
        if (isEmbedded()) {
            window.orbitParent.postMessage(message, rcmail.env.orbit_parent_origin);
        }
    }

    function closeOrbitTab() {
        if (orbitTab) {
            orbitTab.close();
            orbitTab = null;
        }
    }

    function selectedUid() {
        return rcmail.message_list ? rcmail.message_list.get_single_selection() : rcmail.env.uid;
    }

    function requestReference() {
        var uid = selectedUid();

        if (!uid) {
            return;
        }

        if (!isEmbedded()) {
            if (!rcmail.env.orbit_convert_link) {
                rcmail.display_message(rcmail.get_label('conversionfailed', 'orbit_bridge'), 'error');
                return;
            }

            // Opened during the click: Safari blocks a tab opened once the request returns.
            orbitTab = window.open('', '_blank');

            if (orbitTab) {
                orbitTab.opener = null;
            }
        }

        rcmail.http_post(REFERENCE_ACTION, {
            _uid: uid,
            _mbox: rcmail.get_message_mailbox(uid),
        });
    }

    function openInOrbit(reference) {
        var url = rcmail.env.orbit_convert_link
            + '&convert=1'
            + '&folder=' + encodeURIComponent(reference.folder)
            + '&uid=' + encodeURIComponent(reference.uid)
            + '&uidValidity=' + encodeURIComponent(reference.uidValidity);

        if (orbitTab) {
            orbitTab.location.replace(url);
            orbitTab = null;
        } else {
            window.location.assign(url);
        }
    }

    function handleReference(reference) {
        if (isEmbedded()) {
            postToOrbit({
                type: 'orbit.webmail.convert',
                mailboxId: reference.mailboxId,
                folder: reference.folder,
                uid: reference.uid,
                uidValidity: reference.uidValidity,
            });
        } else {
            openInOrbit(reference);
        }
    }

    function stopBackgroundRequests() {
        rcmail.env.session_lifetime = 0;
        clearInterval(rcmail._keepalive);
        clearInterval(rcmail._refresh);
    }

    function reportSessionLost(details) {
        if (sessionLostReported) {
            return;
        }

        sessionLostReported = true;
        stopBackgroundRequests();
        closeOrbitTab();

        // Roundcube's own preview frames have no direct line to Orbit.
        if (rcmail.is_framed()) {
            parent.rcmail.triggerEvent(SESSION_LOST_EVENT, details);
        } else {
            postToOrbit({ type: 'orbit.webmail.session_lost', reason: details.reason });
        }
    }

    function initConvertButton() {
        rcmail.register_command(CONVERT_COMMAND, requestReference);
        rcmail.enable_command(CONVERT_COMMAND, !!rcmail.env.uid);
        rcmail.addEventListener(REFERENCE_ACTION, handleReference);
        rcmail.addEventListener(REFERENCE_FAILED_ACTION, closeOrbitTab);

        if (rcmail.message_list) {
            rcmail.message_list.addEventListener('select', function (list) {
                rcmail.enable_command(CONVERT_COMMAND, list.get_single_selection() !== null);
            });
        }
    }

    rcmail.addEventListener('init', function () {
        rcmail.addEventListener(SESSION_LOST_EVENT, reportSessionLost);

        if (rcmail.message_list && isDisabled('move')) {
            rcmail.message_list.draggable = false;
        }

        if (rcmail.env.orbit_can_convert) {
            initConvertButton();
        }

        // A blocked login still fires the iframe's load event; this only runs on a
        // rendered page of a live session.
        postToOrbit({ type: 'orbit.webmail.ready' });
    });
})();
