// GoFile filename hints (from API) so we don't rely on URL-encoded path segments
const gofileNameById = new Map();
const gofileNameByUrl = new Map();

// GoFile: the site itself authenticates CDN downloads (store*/cache*.gofile.io) via an
// "accountToken" cookie, set client-side in account.js as:
//   document.cookie = "accountToken=" + activeAccount.token + ";path=/;domain=gofile.io;SameSite=Lax;Secure;"
// Our GM_xmlhttpRequest download calls send cookies (anonymous: false), so mirroring that
// cookie with OUR already-resolved guest token keeps resolution and download on the same
// account. (The old warm-up-tab-only approach loaded a bare gofile.io tab whose own JS has
// no knowledge of our token -- it creates and cookies a brand-new, unrelated guest account,
// which only works by chance.) Cheap local browser API, safe to call before every request.
//
// Whatever accountToken cookie already exists (e.g. the user's own logged-in GoFile session)
// gets overwritten by this. Capture it once per run so it can be restored via
// gofileRestoreCookie() once no post is still processing (see setProcessing() below).
let gofileCookieCaptured = false;
let gofileOriginalCookieValue = null; // null = no cookie existed originally

const gofileCaptureOriginalCookie = () =>
    new Promise(resolve => {
        if (gofileCookieCaptured || typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.list !== 'function') {
            resolve();
            return;
        }
        try {
            GM_cookie.list({ url: 'https://gofile.io/', domain: 'gofile.io', name: 'accountToken' }, (cookies, error) => {
                if (error) {
                    console.warn('[GoFile] GM_cookie.list failed while capturing original accountToken cookie:', error);
                } else {
                    const existing = Array.isArray(cookies) ? cookies.find(c => c && c.name === 'accountToken') : null;
                    gofileOriginalCookieValue = existing ? existing.value : null;
                }
                gofileCookieCaptured = true;
                resolve();
            });
        } catch (e) {
            console.warn('[GoFile] GM_cookie.list threw while capturing original accountToken cookie:', e);
            gofileCookieCaptured = true;
            resolve();
        }
    });

const gofileSyncCookie = token =>
    new Promise(resolve => {
        (async () => {
            try {
                if (!token || typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.set !== 'function') {
                    resolve(false);
                    return;
                }
                await gofileCaptureOriginalCookie();
                GM_cookie.set(
                    {
                        url: 'https://gofile.io/',
                        name: 'accountToken',
                        value: String(token),
                        domain: 'gofile.io',
                        path: '/',
                        secure: true,
                        sameSite: 'lax',
                    },
                    error => {
                        if (error) console.warn('[GoFile] GM_cookie.set failed for accountToken:', error);
                        resolve(!error);
                    },
                );
            } catch (e) {
                console.warn('[GoFile] gofileSyncCookie threw:', e);
                resolve(false);
            }
        })();
    });

// Restore whatever accountToken cookie existed before we started overwriting it (or remove
// ours if none existed). Called once no post is still processing -- see setProcessing() below.
const gofileRestoreCookie = () =>
    new Promise(resolve => {
        try {
            if (!gofileCookieCaptured || typeof GM_cookie === 'undefined' || !GM_cookie) {
                resolve();
                return;
            }
            const originalValue = gofileOriginalCookieValue;
            gofileCookieCaptured = false;
            gofileOriginalCookieValue = null;

            if (originalValue === null) {
                if (typeof GM_cookie.delete === 'function') {
                    GM_cookie.delete({ url: 'https://gofile.io/', name: 'accountToken', domain: 'gofile.io', path: '/' }, error => {
                        if (error) console.warn('[GoFile] Failed to remove guest accountToken cookie during restore:', error);
                        resolve();
                    });
                    return;
                }
                resolve();
                return;
            }

            GM_cookie.set(
                {
                    url: 'https://gofile.io/',
                    name: 'accountToken',
                    value: originalValue,
                    domain: 'gofile.io',
                    path: '/',
                    secure: true,
                    sameSite: 'lax',
                },
                error => {
                    if (error) console.warn('[GoFile] Failed to restore original accountToken cookie:', error);
                    resolve();
                },
            );
        } catch (e) {
            resolve();
        }
    });

// Cyberdrop filename hints (from API)
const cyberdropNameBySlug = new Map();
const cyberdropNameByUrl = new Map();

// Filester filename/size hints (from API)
const filesterNameBySlug = new Map();
const filesterNameByUrl = new Map();
const filesterSizeBySlug = new Map();
const filesterSizeByUrl = new Map();
const filesterSlugByUrl = new Map();
const filesterRefByUrl = new Map();

// Filester: cache candidate fallback (some tokens are served from different cacheN hosts; cache6 is common but not guaranteed)
const filesterCandidatesByToken = new Map(); // token -> string[]
const filesterTriedByToken = new Map();      // token -> Set<string> of tried candidate URLs
const filester429AttemptsByKey = new Map(); // token/url -> number of 429 retries (rate limiting)
const filesterRetryAttemptsByKey = new Map(); // token/url -> number of retries on transient HTTP errors (429/400/etc)


function filesterTokenFromVUrl(u) {
    try {
        const m = /\/v\/([^\/?#]+)/i.exec(String(u || ''));
        return m && m[1] ? String(m[1]) : '';
    } catch (e) { return ''; }
}

function filesterBuildCandidates(token) {
    const t = String(token || '').trim();
    if (!t) return [];
    const order = [6, 1, 2, 3, 4, 5, 7, 8];
    const out = [];
    for (const n of order) out.push(`https://cache${n}.filester.me/v/${t}`);
    out.push(`https://filester.me/v/${t}`);
    return out;
}

// Bunkr filename hints (from /v/ pages)
const bunkrNameByUrl = new Map();

// Goonbox: embedded medium-res thumbnail per /img/ link, used as a download fallback when the
// API's original_url 404s (post-migration, some originals are missing but the .md. thumbnail --
// also hosted on cuckcapital.cr -- still exists).
const goonboxThumbByUrl = new Map();

