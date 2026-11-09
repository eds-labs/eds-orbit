/* Orbit bridge: hands a selected message over to the Orbit ticket dialog. */
(function () {
    var COMMAND = 'plugin.orbit_bridge.convert';
    var REFERENCE_ACTION = 'plugin.orbit_bridge.convert_reference';

    function selectedUid() {
        return rcmail.message_list ? rcmail.message_list.get_single_selection() : rcmail.env.uid;
    }

    function requestReference() {
        var uid = selectedUid();

        if (uid) {
            rcmail.http_post(REFERENCE_ACTION, {
                _uid: uid,
                _mbox: rcmail.get_message_mailbox(uid),
            });
        }
    }

    function postReference(reference) {
        window.orbitParent.postMessage({
            type: 'orbit.webmail.convert',
            folder: reference.folder,
            uid: reference.uid,
            uidValidity: reference.uidValidity,
        }, rcmail.env.orbit_parent_origin);
    }

    rcmail.addEventListener('init', function () {
        rcmail.register_command(COMMAND, requestReference);
        rcmail.enable_command(COMMAND, !!rcmail.env.uid);
        rcmail.addEventListener(REFERENCE_ACTION, postReference);

        if (rcmail.message_list) {
            rcmail.message_list.addEventListener('select', function (list) {
                rcmail.enable_command(COMMAND, list.get_single_selection() !== null);
            });
        }
    });
})();
