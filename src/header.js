// ==UserScript==
// @name XenForoPostDownloader
// @namespace https://github.com/SkyCloudDev
// @author SkyCloudDev
// @description Downloads images and videos from posts
// @version 4.2.0
// @updateURL https://github.com/Mothball7205/ForumPostDownloader/raw/main/dist/build.user.js
// @downloadURL https://github.com/Mothball7205/ForumPostDownloader/raw/main/dist/build.user.js
// @icon https://simp4.cuckcapital.cr/simpcityIcon192.png
// @license WTFPL; http://www.wtfpl.net/txt/copying/
// @match https://simpcity.cr/threads/*
// @match https://simpcity.is/threads/*
// @match https://simpcity.cz/threads/*
// @match https://simpcity.hk/threads/*
// @match https://simpcity.rs/threads/*
// @match https://simpcity.ax/threads/*
// @match https://gofile.io/*
// @match https://goonbox.cr/img/*
// @match https://goonbox.cr/a/*
// @match https://www.goonbox.cr/img/*
// @match https://www.goonbox.cr/a/*
// @require https://unpkg.com/@popperjs/core@2
// @require https://unpkg.com/tippy.js@6
// @require https://unpkg.com/file-saver@2.0.4/dist/FileSaver.min.js
// @require https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require https://raw.githubusercontent.com/geraintluff/sha256/gh-pages/sha256.min.js
// @connect self
// @connect simpcity.su
// @connect coomer.st
// @connect box.com
// @connect boxcloud.com
// @connect kemono.cr
// @connect github.com
// @connect scdn.st
// @connect cache8.st
// @connect bunkr.ac
// @connect bunkr.ax
// @connect bunkr.black
// @connect bunkr.cat
// @connect bunkr.ci
// @connect bunkr.cr
// @connect bunkr.fi
// @connect bunkr.is
// @connect bunkr.media
// @connect bunkr.nu
// @connect bunkr.red
// @connect bunkr.ru
// @connect bunkr.se
// @connect bunkr.si
// @connect bunkr.site
// @connect bunkr.pk
// @connect bunkr.ph
// @connect bunkr.ps
// @connect bunkr.sk
// @connect bunkr.ws
// @connect bunkrr.ru
// @connect bunkrr.su
// @connect bunkrrr.org
// @connect bunkr-cache.se
// @connect apidl.bunkr.ru
// @connect get.bunkrr.su
// @connect cdn.cr
// @connect glb-apisign.cdn.cr
// @connect b-cdn.net
// @connect gigachad-cdn.ru
// @connect cyberdrop.me
// @connect cyberdrop.cc
// @connect cyberdrop.ch
// @connect cyberdrop.cloud
// @connect cyberdrop.nl
// @connect cyberdrop.to
// @connect cyberdrop.cr
// @connect cyberfile.su
// @connect cyberfile.me
// @connect turbo.cr
// @connect turbocdn.st
// @connect saint2.su
// @connect saint2.cr
// @connect redd.it
// @connect onlyfans.com
// @connect i.ibb.co
// @connect ibb.co
// @connect imagebam.com
// @connect jpg.fish
// @connect jpg.fishing
// @connect jpg.pet
// @connect jpeg.pet
// @connect jpg1.su
// @connect jpg2.su
// @connect jpg3.su
// @connect jpg4.su
// @connect jpg5.su
// @connect jpg6.su
// @connect jpg7.cr
// @connect cuckcapital.cr
// @connect imgbox.com
// @connect pixhost.to
// @connect pomf2.lain.la
// @connect pornhub.com
// @connect postimg.cc
// @connect imgvb.com
// @connect pixxxels.cc
// @connect imagevenue.com
// @connect nhentai-proxy.herokuapp.com
// @connect pbs.twimg.com
// @connect media.tumblr.com
// @connect pixeldrain.com
// @connect pixeldrain.net
// @connect pixeldra.in
// @connect redgifs.com
// @connect rule34.xxx
// @connect noodlemagazine.com
// @connect pvvstream.pro
// @connect spankbang.com
// @connect sb-cd.com
// @connect gofile.io
// @connect phncdn.com
// @connect xvideos.com
// @connect give.xxx
// @connect goonbox.cr
// @connect githubusercontent.com
// @connect filester.me
// @connect filester.sh
// @connect filester.si
// @connect filester.gg
// @run-at document-start
// @grant GM_xmlhttpRequest
// @grant GM_download
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_addValueChangeListener
// @grant GM_removeValueChangeListener
// @grant GM_deleteValue
// @grant GM_log
// @grant GM_openInTab
// @grant GM_cookie

// ==/UserScript==
// Tab cleanup is best-effort; userscript managers may return a handle or a promise.
function xfpdCloseTabHandle(tabOrPromise) {
  try {
    if (!tabOrPromise) return;
    if (typeof tabOrPromise.then === 'function') {
      tabOrPromise
        .then(tab => {
          try {
            if (tab && typeof tab.close === 'function') tab.close();
          } catch {}
        })
        .catch(() => {});
      return;
    }
    if (typeof tabOrPromise.close === 'function') tabOrPromise.close();
  } catch (e) {}
}
