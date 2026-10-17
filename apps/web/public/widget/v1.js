/*
 * Orbit support widget v1 (WP5.4). Embed:
 *   <script>window.OrbitSupportConfig = { key: "pk_…", locale: "de" };</script>
 *   <script src="https://<orbit>/widget/v1.js" async></script>
 * Verified users: the host app's backend computes
 *   HMAC_SHA256(widgetSecret, userId) as hex and passes { user: { id, signature } }.
 * The widget talks only to Orbit's public API, lives in a Shadow DOM and
 * fails silently: if Orbit is unreachable, the host page is unaffected.
 */
(function (global) {
  "use strict";
  var TEXT = {
    en: {
      open: "Open support chat",
      close: "Close support chat",
      title: "Support",
      email: "Your e-mail",
      name: "Your name (optional)",
      start: "Start",
      intro: "Ask us anything. We usually answer within a day.",
      newChat: "New conversation",
      none: "No conversations yet.",
      message: "Your message",
      send: "Send",
      back: "Back",
      human: "Talk to a human",
      handedOff: "A person from our team will take over.",
      you: "You",
      team: "Support",
      offline: "Support is not reachable right now. Please try again later.",
      closed: "This conversation is closed.",
    },
    de: {
      open: "Support-Chat öffnen",
      close: "Support-Chat schließen",
      title: "Support",
      email: "Deine E-Mail",
      name: "Dein Name (optional)",
      start: "Starten",
      intro: "Frag uns alles. Wir antworten meist innerhalb eines Tages.",
      newChat: "Neues Gespräch",
      none: "Noch keine Gespräche.",
      message: "Deine Nachricht",
      send: "Senden",
      back: "Zurück",
      human: "Mit einem Menschen sprechen",
      handedOff: "Eine Person aus unserem Team übernimmt.",
      you: "Du",
      team: "Support",
      offline: "Der Support ist gerade nicht erreichbar. Bitte versuche es später.",
      closed: "Dieses Gespräch ist geschlossen.",
    },
  };

  /** The words for a locale; English unless German is asked for. */
  function text(locale) {
    return String(locale || "").toLowerCase().indexOf("de") === 0 ? TEXT.de : TEXT.en;
  }

  /** The widget API base for a key, at the origin the script was loaded from. */
  function apiBase(scriptSrc, key) {
    if (!/^pk_[A-Za-z0-9_-]{32,64}$/.test(String(key || ""))) return null;
    try {
      return new URL(scriptSrc).origin + "/api/public/support/" + key;
    } catch (e) {
      return null;
    }
  }

  /**
   * Splits server-sent events out of a text buffer: complete events and the
   * unfinished rest. Each event has id (number or null), event and data.
   */
  function parseSse(buffer) {
    var events = [];
    var blocks = buffer.split("\n\n");
    var rest = blocks.pop();
    for (var i = 0; i < blocks.length; i++) {
      var ev = { id: null, event: "message", data: "" };
      var lines = blocks[i].split("\n");
      var seen = false;
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        var at = line.indexOf(":");
        if (at <= 0) continue;
        var field = line.slice(0, at);
        var value = line.slice(at + 1).replace(/^ /, "");
        if (field === "id") ev.id = Number(value);
        else if (field === "event") ev.event = value;
        else if (field === "data") {
          ev.data += (ev.data ? "\n" : "") + value;
          seen = true;
        }
      }
      if (seen) events.push(ev);
    }
    return { events: events, rest: rest };
  }

  function storageGet(key) {
    try {
      return global.sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      if (value === null) global.sessionStorage.removeItem(key);
      else global.sessionStorage.setItem(key, value);
    } catch (e) {
      /* storage blocked: the session lasts as long as the page */
    }
  }

  var STYLE =
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    ".launcher{position:fixed;right:16px;bottom:16px;width:56px;height:56px;border-radius:28px;border:0;background:var(--osw-color,#1f6feb);color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483646}" +
    ".launcher:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible{outline:3px solid #ffbf47;outline-offset:2px}" +
    ".panel{position:fixed;right:16px;bottom:84px;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 110px));background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647}" +
    ".panel[hidden]{display:none}" +
    "header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--osw-color,#1f6feb);color:#fff}" +
    "header h2{font-size:16px;margin:0}" +
    "header button{background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer}" +
    ".body{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}" +
    "label{display:flex;flex-direction:column;gap:4px;font-size:13px}" +
    "input,textarea{font:inherit;font-size:14px;padding:8px;border:1px solid #bbb;border-radius:8px;width:100%}" +
    "button.primary{background:var(--osw-color,#1f6feb);color:#fff;border:0;border-radius:8px;padding:9px 12px;font-size:14px;cursor:pointer}" +
    "button.link{background:transparent;border:0;color:#1f6feb;cursor:pointer;padding:4px 0;text-align:left;font-size:14px}" +
    "ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}" +
    ".msg{padding:8px 10px;border-radius:10px;max-width:85%;white-space:pre-wrap;word-wrap:break-word;font-size:14px}" +
    ".msg.customer{align-self:flex-end;background:#e8f0fe}" +
    ".msg.agent{align-self:flex-start;background:#f1f1f1}" +
    ".note{font-size:13px;color:#555}" +
    "form.composer{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-top:1px solid #ddd}";

  function create(doc, tag, attrs, children) {
    var el = doc.createElement(tag);
    for (var name in attrs || {}) {
      if (name === "text") el.textContent = attrs[name];
      else if (name.indexOf("on") === 0) el.addEventListener(name.slice(2), attrs[name]);
      else el.setAttribute(name, attrs[name]);
    }
    (children || []).forEach(function (child) {
      if (child) el.appendChild(child);
    });
    return el;
  }

  function Widget(config, scriptSrc) {
    var doc = global.document;
    var t = text(config.locale || (global.navigator && global.navigator.language));
    var base = apiBase(scriptSrc, config.key);
    if (!base || !doc) return null;
    var tokenKey = "orbit-support:" + config.key;
    var state = { token: storageGet(tokenKey), ticketId: null, cursor: 0, stream: null, poll: null };

    function call(method, path, body, retried) {
      return ensureSession().then(function () {
        return global.fetch(base + path, {
          method: method,
          headers: Object.assign(
            { authorization: "Bearer " + state.token },
            body ? { "content-type": "application/json" } : {},
          ),
          body: body ? JSON.stringify(body) : undefined,
          credentials: "omit",
        });
      }).then(function (res) {
        if (res.status === 401 && !retried) {
          state.token = null;
          storageSet(tokenKey, null);
          return call(method, path, body, true);
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }
    function ensureSession() {
      if (state.token) return Promise.resolve();
      return global
        .fetch(base + "/session", { method: "POST", credentials: "omit" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (session) {
          state.token = session.token;
          storageSet(tokenKey, session.token);
        });
    }

    var host = create(doc, "div", { "data-orbit-support": "" });
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    if (config.color) host.style.setProperty("--osw-color", String(config.color));
    root.appendChild(create(doc, "style", { text: STYLE }));
    var body = create(doc, "div", { class: "body", "aria-live": "polite" });
    var panel = create(doc, "section", { class: "panel", role: "dialog", "aria-label": config.title || t.title, hidden: "" }, [
      create(doc, "header", {}, [
        create(doc, "h2", { text: config.title || t.title }),
        create(doc, "button", { type: "button", "aria-label": t.close, text: "×", onclick: close }),
      ]),
      body,
    ]);
    var launcher = create(doc, "button", { class: "launcher", type: "button", "aria-label": t.open, "aria-expanded": "false", text: "?", onclick: toggle });
    root.appendChild(panel);
    root.appendChild(launcher);
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });

    function clear() {
      stopLive();
      while (body.firstChild) body.removeChild(body.firstChild);
      var old = panel.querySelector("form.composer");
      if (old) old.remove();
    }
    function fail() {
      clear();
      body.appendChild(create(doc, "p", { class: "note", text: t.offline }));
    }
    function toggle() {
      if (panel.hasAttribute("hidden")) open();
      else close();
    }
    function open() {
      panel.removeAttribute("hidden");
      launcher.setAttribute("aria-expanded", "true");
      identify().then(showList, showIdentify);
    }
    function close() {
      stopLive();
      panel.setAttribute("hidden", "");
      launcher.setAttribute("aria-expanded", "false");
      launcher.focus();
    }
    function identify() {
      if (config.user && config.user.id && config.user.signature)
        return call("POST", "/identify", {
          externalUserId: String(config.user.id),
          signature: String(config.user.signature),
          email: config.user.email || undefined,
          name: config.user.name || undefined,
          locale: config.locale || undefined,
        });
      if (state.identified) return Promise.resolve();
      return Promise.reject(new Error("anonymous"));
    }
    function showIdentify() {
      clear();
      var email = create(doc, "input", { type: "email", required: "", autocomplete: "email" });
      var name = create(doc, "input", { type: "text", autocomplete: "name" });
      var form = create(doc, "form", {
        onsubmit: function (e) {
          e.preventDefault();
          call("POST", "/identify", { email: email.value.trim(), name: name.value.trim() || undefined })
            .then(function () {
              state.identified = true;
              showList();
            }, fail);
        },
      }, [
        create(doc, "p", { class: "note", text: t.intro }),
        create(doc, "label", {}, [doc.createTextNode(t.email), email]),
        create(doc, "label", {}, [doc.createTextNode(t.name), name]),
        create(doc, "button", { class: "primary", type: "submit", text: t.start }),
      ]);
      body.appendChild(form);
      email.focus();
    }
    function showList() {
      clear();
      body.appendChild(create(doc, "button", { class: "primary", type: "button", text: t.newChat, onclick: function () { showConversation(null); } }));
      call("GET", "/conversations").then(function (result) {
        var items = result.items || [];
        if (!items.length) return body.appendChild(create(doc, "p", { class: "note", text: t.none }));
        body.appendChild(create(doc, "ul", {}, items.map(function (c) {
          return create(doc, "li", {}, [create(doc, "button", { class: "link", type: "button", text: "#" + c.number + " " + c.subject, onclick: function () { showConversation(c.ticketId); } })]);
        })));
      }, fail);
    }
    function render(list, message) {
      list.appendChild(create(doc, "li", { class: "msg " + (message.from === "customer" ? "customer" : "agent") }, [
        create(doc, "span", { class: "note", text: (message.from === "customer" ? t.you : t.team) + ": " }),
        doc.createTextNode(message.bodyText),
      ]));
      body.scrollTop = body.scrollHeight;
    }
    function showConversation(ticketId) {
      clear();
      state.ticketId = ticketId;
      state.cursor = 0;
      var list = create(doc, "ul");
      body.appendChild(create(doc, "button", { class: "link", type: "button", text: "← " + t.back, onclick: showList }));
      body.appendChild(list);
      var input = create(doc, "textarea", { rows: "3", "aria-label": t.message, required: "" });
      var composer = create(doc, "form", {
        class: "composer",
        onsubmit: function (e) {
          e.preventDefault();
          var value = input.value.trim();
          if (!value) return;
          var sent = state.ticketId
            ? call("POST", "/messages", { ticketId: state.ticketId, bodyText: value })
            : call("POST", "/conversations", { bodyText: value }).then(function (created) {
                state.ticketId = created.ticketId;
                startLive(list);
              });
          sent.then(function () {
            input.value = "";
            if (!state.live) refresh(list);
          }, fail);
        },
      }, [
        input,
        create(doc, "button", { class: "primary", type: "submit", text: t.send }),
        create(doc, "button", { class: "link", type: "button", text: t.human, onclick: function () {
          if (!state.ticketId) return;
          call("POST", "/handoff", { ticketId: state.ticketId }).then(function () {
            body.appendChild(create(doc, "p", { class: "note", text: t.handedOff }));
          }, fail);
        } }),
      ]);
      panel.appendChild(composer);
      input.focus();
      if (ticketId) startLive(list);
    }
    function refresh(list) {
      if (!state.ticketId) return Promise.resolve();
      return call("GET", "/messages?ticket=" + state.ticketId + "&after=" + state.cursor).then(function (result) {
        (result.items || []).forEach(function (m) {
          if (m.id > state.cursor) {
            state.cursor = m.id;
            render(list, m);
          }
        });
      });
    }
    // Live updates: the event stream (fetch, so it can carry the token),
    // reconnecting with Last-Event-ID; polling every 5 s if streaming fails.
    function startLive(list) {
      stopLive();
      state.live = true;
      var controller = global.AbortController ? new global.AbortController() : null;
      state.stream = controller;
      function connect() {
        if (state.stream !== controller) return;
        ensureSession().then(function () {
          return global.fetch(base + "/stream?ticket=" + state.ticketId, {
            headers: { authorization: "Bearer " + state.token, "last-event-id": String(state.cursor) },
            signal: controller ? controller.signal : undefined,
            credentials: "omit",
          });
        }).then(function (res) {
          if (!res.ok || !res.body || !res.body.getReader) throw new Error("no stream");
          var reader = res.body.getReader();
          var decoder = new global.TextDecoder();
          var buffer = "";
          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return;
              var parsed = parseSse(buffer + decoder.decode(chunk.value, { stream: true }));
              buffer = parsed.rest;
              parsed.events.forEach(function (ev) {
                if (ev.event !== "message" || ev.id === null || ev.id <= state.cursor) return;
                state.cursor = ev.id;
                try { render(list, JSON.parse(ev.data)); } catch (e) { /* ignore */ }
              });
              return pump();
            });
          }
          return pump();
        }).then(function () {
          global.setTimeout(connect, 1000);
        }, function () {
          if (state.stream !== controller) return;
          state.live = false;
          refresh(list);
          state.poll = global.setInterval(function () { refresh(list); }, 5000);
        });
      }
      connect();
    }
    function stopLive() {
      if (state.stream && state.stream.abort) state.stream.abort();
      state.stream = null;
      state.live = false;
      if (state.poll) global.clearInterval(state.poll);
      state.poll = null;
    }

    doc.body.appendChild(host);
    return { open: open, close: close, element: host };
  }

  var scriptSrc = (global.document && global.document.currentScript && global.document.currentScript.src) || "";
  var api = {
    version: "1",
    init: function (config) {
      try {
        return Widget(config || {}, scriptSrc);
      } catch (e) {
        return null; /* never break the host page */
      }
    },
    _internals: { text: text, apiBase: apiBase, parseSse: parseSse },
  };
  global.OrbitSupport = api;
  if (global.OrbitSupportConfig && global.document) {
    var start = function () { api.init(global.OrbitSupportConfig); };
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
