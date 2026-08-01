// Thin orchestrator: wires the per-post pipeline together. All host resolution,
// GoFile state, and artifact work runs inside runWithPostProcessing so cookie
// restoration and the log cleanup are guaranteed even on early failures.
const downloadPost = async (parsedPost, parsedHosts, enabledHostsCB, resolvers, getSettingsCB, statusUI, callbacks = {}) => {
  const { postId, postNumber } = parsedPost;

  try {
    await runWithPostProcessing(postId, async () => {
      const postSettings = getSettingsCB();

      const enabledHosts = enabledHostsCB(parsedHosts);

      // TODO: Fix this filth.
      window.logs = window.logs.filter(l => l.postId !== postId);

      log.separator(postId);
      log.post.info(postId, `::Using ${enabledHosts.length} host(s)::: ${enabledHosts.map(h => h.name).join(', ')}`, postNumber);

      log.separator(postId);
      log.post.info(postId, `::Preparing download::`, postNumber);

      let completed = 0;
      const zip = new JSZip();
      let zipFileCount = 0;
      let resolved = [];

      const statusLabel = statusUI.status;
      const filePB = statusUI.filePB;
      const totalPB = statusUI.totalPB;

      h.ui.setElProps(statusLabel, {
        color: '#469cf3',
        marginBottom: '3px',
        fontSize: '12px',
      });

      h.ui.setElProps(filePB, {
        width: '0%',
        marginBottom: '1px',
      });

      h.ui.setElProps(totalPB, {
        width: '0%',
        marginBottom: '10px',
      });

      h.show(statusLabel);
      h.show(filePB);
      h.show(totalPB);

      h.ui.setText(statusLabel, 'Resolving...');

      captureDownloadHints(parsedPost);

      resolved = await resolveDownloadResources({ parsedPost, enabledHosts, resolvers, postSettings, statusLabel });

      let totalDownloadable = resolved.filter(r => r.url).length;

      const totalResources = enabledHosts.reduce((acc, h) => h.resources.length + acc, 0);

      log.separator(postId);
      log.post.info(postId, `::Found ${totalDownloadable} resource(s)::`, postNumber);
      log.separator(postId);

      const threadTitle = parsers.thread.parseTitle();

      let customFilename = postSettings.output.find(o => o.postId === postId)?.value;

      if (customFilename) {
        customFilename = customFilename.replace(/:title:/g, threadTitle);
        customFilename = customFilename.replace(/:#:/g, postNumber);
        customFilename = customFilename.replace(/:id:/g, postId);
      }

      if (postSettings.skipDuplicates) {
        const deduped = removeDuplicateDownloadResources(resolved, { postId, postNumber, statusLabel });
        if (deduped !== resolved) {
          resolved = deduped;
          totalDownloadable = resolved.length;
        }
      }

      const isFF = window.isFF;

      // Filester album policy runs exactly once per post (after dedupe, before batching)
      // with its own metadata reader so no per-batch re-probes happen.
      if (!postSettings.skipDownload) {
        const policyReader = createDownloadMetadataReader();
        await applyFilesterAlbumPolicy(resolved, {
          zipped: postSettings.zipped,
          readMetadata: policyReader.readDownloadMetadata,
          postId,
          postNumber,
        });
      }

      const names = createDownloadNamePlanner({ postSettings, threadTitle, postNumber, isFirefox: isFF });

      const run = {
        postId,
        postNumber,
        postSettings,
        statusUI,
        threadTitle,
        isFirefox: isFF,
        resolved,
        totalResources,
        totalDownloadable,
        completed,
        zip,
        zipFileCount,
        names,
        cyberdropDirectWarmupDone: false,
      };

      await runDownloadTransfers(run);

      totalDownloadable = run.totalDownloadable;
      completed = run.completed;

      await finalizeDownloadArtifacts(run, customFilename);

      if (totalDownloadable > 0) {
        // For logging in console since post logs are already written.
        if (!postSettings.skipDownload) {
          log.post.info(postId, `::Download completed::`, postNumber);
        } else {
          log.post.info(postId, `::Links generation completed::`, postNumber);
        }

        callbacks && callbacks.onComplete && callbacks.onComplete(totalDownloadable, completed);
      }
    });
  } finally {
    window.logs = window.logs.filter(l => l.postId !== postId);
  }
};
