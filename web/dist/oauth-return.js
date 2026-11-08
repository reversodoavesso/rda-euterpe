// A new 200 document ends the consent form's CSP redirect chain. Never fetch
// the callback: OAuth returns through top-level navigation, without credentials
// in browser storage, logs or a cross-origin Referer.
"use strict";
const continuation = document.getElementById("oauth-continue");
if (continuation) window.location.replace(continuation.href);
