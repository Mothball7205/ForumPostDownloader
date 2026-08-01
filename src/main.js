const parsedPosts = [];
const selectedPosts = [];

(function () {
    try { if (window.__XFPD_ABORT_MAIN) return; } catch (e) {}

    // @match now covers gofile.io (required by GM_cookie for the accountToken sync -- see
    // gofileSyncCookie), which also makes Tampermonkey inject/run this whole script on actual
    // gofile.io page loads (e.g. the warm-up tab). None of the forum-post logic below applies
    // there, so bail out immediately rather than doing pointless work (redgifs token fetch,
    // style injection) on GoFile's own pages.
    try { if (/(^|\.)gofile\.io$/i.test(location.hostname)) return; } catch (e) {}

    window.addEventListener('beforeunload', e => {
        if (processing.find(p => p.processing)) {
            const message = 'Downloads are in progress. Sure you wanna exit this page?';
            e.returnValue = message;
            return message;
        }
    });

    document.addEventListener('DOMContentLoaded', async () => {


        try {
            const { source, status } = await h.http.get('https://api.redgifs.com/v2/auth/temporary', {}, {}, 'text');
            if (status !== 200) { throw new Error(`HTTP ${status}`); }
            if (h.contains('token', source)) {
                const token = JSON.parse(source).token;
                GM_setValue('redgifs_token', token);
            }
        } catch (e) {
            console.error('Error getting temporary redgifs auth token:');
            console.error(e);
        }

        init.injectCustomStyles();

        h.elements('.message-attribution-opposite').forEach(post => {
            const settings = {
                zipped: true,
                flatten: false,
                generateLinks: false,
                generateLog: false,
                skipDuplicates: false,
                skipDownload: false,
                verifyBunkrLinks: false,                output: [],
            };

            const parsedPost = parsers.thread.parsePost(post);

            const { content, contentContainer } = parsedPost;

            addDuplicateTabLink(post);
            addShowDownloadPageBtnLink(post);

            const parsedHosts = parsers.hosts.parseHosts(content);

            const getEnabledHostsCB = parsedHosts => parsedHosts.filter(host => host.enabled);

            if (!parsedHosts.length) {
                return;
            }

            const getTotalDownloadableResourcesForPostCB = parsedHosts => {
                return parsedHosts.filter(host => host.enabled && host.resources.length).reduce((acc, host) => acc + host.resources.length, 0);
            };

            // Create and attach the download button to post.
            const { btn: btnDownloadPost } = ui.buttons.addDownloadPostButton(post);
            const totalResources = parsedHosts.reduce((acc, host) => acc + host.resources.length, 0);
            const checkedLength = getTotalDownloadableResourcesForPostCB(parsedHosts);
            btnDownloadPost.innerHTML = `🡳 Download (${checkedLength}/${totalResources})`;

            // Create download status / progress elements.
            const { el: statusText } = ui.labels.status.createStatusLabel();
            const filePBar = ui.pBars.createFileProgressBar();
            const totalPBar = ui.pBars.createTotalProgressBar();

            contentContainer.prepend(totalPBar);
            contentContainer.prepend(filePBar);
            contentContainer.prepend(statusText);

            h.hide(statusText);
            h.hide(filePBar);
            h.hide(totalPBar);

            const onFormSubmitCB = data => {
                const { tippyInstance } = data;
                tippyInstance.hide();
            };

            ui.forms.config.post.createPostConfigForm(
                parsedPost,
                parsedHosts,
                `#${parsedPost.postNumber}.zip`,
                settings,
                onFormSubmitCB,
                getTotalDownloadableResourcesForPostCB,
                btnDownloadPost,
            );

            const statusUI = {
                status: statusText,
                filePB: filePBar,
                totalPB: totalPBar,
            };

            const postDownloadCallbacks = {
                onComplete: (total, completed) => {
                    if (total > 0 && completed > 0) {
                        registerPostReaction(parsedPost.footer);
                    }
                },
            };

            let getSettingsCB = () => settings;

            parsedPosts.push({
                parsedPost,
                parsedHosts,
                enabledHostsCB: getEnabledHostsCB,
                resolvers,
                getSettingsCB,
                statusUI,
                postDownloadCallbacks,
            });

            btnDownloadPost.addEventListener('click', e => {
                e.preventDefault();
                downloadPost(parsedPost, parsedHosts, getEnabledHostsCB, resolvers, getSettingsCB, statusUI, postDownloadCallbacks);
            });
        });

        if (parsedPosts.filter(p => p.parsedHosts.length).length > 0) {
            const btnDownloadPage = addDownloadPageButton();

            btnDownloadPage.addEventListener('click', e => {
                e.preventDefault();

                selectedPosts
                    .filter(s => s.enabled)
                    .forEach(s => {
                    downloadPost(
                        s.post.parsedPost,
                        s.post.parsedHosts,
                        s.post.enabledHostsCB,
                        s.post.resolvers,
                        s.post.getSettingsCB,
                        s.post.statusUI,
                        s.post.postDownloadCallbacks,
                    );
                });
            });

            // TODO: Extract to ui.js
            const color = ui.getTooltipBackgroundColor();

            let html = ui.forms.createCheckbox('config-toggle-all-posts', settings.ui.checkboxes.toggleAllCheckboxLabel, false);

            parsedPosts
                .filter(p => p.parsedHosts.length)
                .forEach(post => {
                const { postId, postNumber, textContent } = post.parsedPost;

                selectedPosts.push({ post, enabled: false });

                const threadTitle = parsers.thread.parseTitle();

                let defaultPostContent = textContent.trim().replace('​', '');

                const ellipsedText = h.limit(defaultPostContent === '' ? threadTitle : defaultPostContent, 20);

                const summary = `<a id="post-content-${postId}" href="#post-${postId}" style="color: #3DB7C7"> ${ellipsedText} </a>`;
                html += ui.forms.createCheckbox(`config-download-post-${postId}`, `Post #${postNumber} ${summary}`, false);
            });

            html = `${ui.forms.createRow(ui.forms.createLabel('Post Selection'))} ${html}`;
            ui.tooltip(btnDownloadPage, ui.forms.config.page.createForm(color, html), {
                placement: 'bottom',
                interactive: true,
                onShown: () => {
                    parsedPosts
                        .filter(p => p.parsedHosts.length)
                        .forEach(post => {
                        const { postId, contentContainer } = post.parsedPost;
                        ui.tooltip(
                            `#post-content-${postId}`,
                            `<div style="overflow-y: auto; background: #242323; padding: 16px; width: 500px; max-height: 500px">
                          ${contentContainer.innerHTML}
                         </div>`,
                            { placement: 'right', offset: [10, 15] },
                        );

                        document.querySelector(`#config-download-post-${postId}`).addEventListener('change', e => {
                            const selectedPost = selectedPosts.find(s => s.post.parsedPost.postId === postId);
                            selectedPost.enabled = e.target.checked;

                            const checkAllCB = h.element('#config-toggle-all-posts');
                            checkAllCB.checked = selectedPosts.filter(s => s.enabled).length === parsedPosts.length;
                        });

                        h.element('#config-toggle-all-posts').addEventListener('change', async e => {
                            e.preventDefault();

                            const checked = e.target.checked;

                            const postCheckboxes = parsedPosts
                            .filter(p => p.parsedHosts.length)
                            .map(p => p.parsedPost)
                            .flatMap(p => h.element(`#config-download-post-${p.postId}`));

                            const checkedPostCheckboxes = postCheckboxes.filter(e => e.checked);
                            const unCheckedPostCheckboxes = postCheckboxes.filter(e => !e.checked);

                            if (checked) {
                                unCheckedPostCheckboxes.forEach(c => c.click());
                            } else {
                                checkedPostCheckboxes.forEach(c => c.click());
                            }
                        });
                    });
                },
            });
        }
    });
})();