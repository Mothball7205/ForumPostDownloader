const canStreamPostDownloads = (enabledHosts, postSettings) => {
  if (postSettings.skipDownload || postSettings.skipDuplicates) return false;
  // Filester policy depends on the complete post's album groups, before any transfer.
  if (enabledHosts.some(host => host.resources.some(isFilesterAlbumOriginal))) return false;
  return enabledHosts.some(host => String(host.name).toLowerCase() === 'bunkr');
};

const logResolvedDownloadCount = run => {
  log.separator(run.postId);
  log.post.info(run.postId, `::Found ${run.totalDownloadable} resource(s)::`, run.postNumber);
  log.separator(run.postId);
};

const runBufferedPostDownloads = async (run, resolutionOptions) => {
  let resolved = await resolveDownloadResources(resolutionOptions);
  if (run.postSettings.skipDuplicates) {
    resolved = removeDuplicateDownloadResources(resolved, {
      postId: run.postId,
      postNumber: run.postNumber,
      statusLabel: run.statusUI.status,
    });
  }
  run.resolved = resolved;
  run.totalDownloadable = resolved.filter(r => r.url).length;
  logResolvedDownloadCount(run);
  if (!run.postSettings.skipDownload) {
    const metadata = createDownloadMetadataReader();
    await applyFilesterAlbumPolicy(resolved, {
      zipped: run.postSettings.zipped,
      readMetadata: metadata.readDownloadMetadata,
      postId: run.postId,
      postNumber: run.postNumber,
    });
  }
  await runDownloadTransfers(run);
};

const runStreamingPostDownloads = async (run, resolutionOptions) => {
  const queue = createDownloadQueue();
  run.resourceQueue = queue;
  // These runs include Bunkr, whose existing host limit is one download at a time.
  // Signed CDN URLs must not bypass that limit.
  run.transferConcurrency = 1;
  run.resolving = true;
  run.activeTransfers = 0;

  const status = run.statusUI.status;
  const pipelineStatus = status.ownerDocument.createElement('div');
  h.ui.setElProps(pipelineStatus, { fontSize: '12px', marginBottom: '3px', color: '#469cf3' });
  status.before(pipelineStatus);
  let resolutionProgress = 'Resolving...';
  run.onTransferProgress = () => {
    const progress = run.resolving ? resolutionProgress : `Resolved: ${run.totalDownloadable}`;
    h.ui.setText(pipelineStatus, `${progress} · ${run.completed} finished · ${run.activeTransfers} downloading`);
    // The final denominator is unknown while more files are being discovered.
    if (run.resolving) h.ui.setElProps(run.statusUI.totalPB, { width: '0%' });
  };
  run.onTransferProgress();

  const produce = async () => {
    try {
      run.resolved = await resolveDownloadResources({
        ...resolutionOptions,
        onError: queue.fail,
        onProgress: text => {
          resolutionProgress = text;
          run.onTransferProgress();
        },
        onResource: async resource => {
          run.totalDownloadable++;
          run.onTransferProgress();
          await queue.push(resource);
        },
      });
      run.resolving = false;
      run.onTransferProgress();
      logResolvedDownloadCount(run);
      queue.close();
    } catch (error) {
      queue.fail(error);
      throw error;
    }
  };
  const consume = async () => {
    try {
      await runDownloadTransfers(run);
    } catch (error) {
      queue.fail(error);
      throw error;
    }
  };
  try {
    // Both tasks must settle before shared credentials, logs or UI are released.
    const outcomes = await Promise.allSettled([produce(), consume()]);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    pipelineStatus.remove();
    delete run.onTransferProgress;
  }
};

// Keep both pipeline stages and artifact saving inside the shared credential lifecycle.
const downloadPost = async (parsedPost, parsedHosts, enabledHostsCB, resolvers, getSettingsCB, statusUI, callbacks = {}) => {
  const { postId, postNumber } = parsedPost;
  try {
    await runWithPostProcessing(postId, async () => {
      const postSettings = getSettingsCB();
      const enabledHosts = enabledHostsCB(parsedHosts);
      window.logs = window.logs.filter(l => l.postId !== postId);
      log.separator(postId);
      log.post.info(postId, `::Using ${enabledHosts.length} host(s)::: ${enabledHosts.map(host => host.name).join(', ')}`, postNumber);
      log.separator(postId);
      log.post.info(postId, `::Preparing download::`, postNumber);

      const statusLabel = statusUI.status;
      h.ui.setElProps(statusLabel, { color: '#469cf3', marginBottom: '3px', fontSize: '12px' });
      h.ui.setElProps(statusUI.filePB, { width: '0%', marginBottom: '1px' });
      h.ui.setElProps(statusUI.totalPB, { width: '0%', marginBottom: '10px' });
      h.show(statusLabel);
      h.show(statusUI.filePB);
      h.show(statusUI.totalPB);
      h.ui.setText(statusLabel, 'Resolving...');
      captureDownloadHints(parsedPost);

      const threadTitle = parsers.thread.parseTitle();
      let customFilename = postSettings.output.find(output => output.postId === postId)?.value;
      if (customFilename) {
        customFilename = customFilename.replace(/:title:/g, threadTitle);
        customFilename = customFilename.replace(/:#:/g, postNumber);
        customFilename = customFilename.replace(/:id:/g, postId);
      }
      const run = {
        postId,
        postNumber,
        postSettings,
        statusUI,
        threadTitle,
        isFirefox: window.isFF,
        resolved: [],
        totalResources: enabledHosts.reduce((total, host) => total + host.resources.length, 0),
        totalDownloadable: 0,
        completed: 0,
        zip: new JSZip(),
        zipFileCount: 0,
        names: createDownloadNamePlanner({ postSettings, threadTitle, postNumber, isFirefox: window.isFF }),
        cyberdropDirectWarmupDone: false,
      };
      const resolutionOptions = { parsedPost, enabledHosts, resolvers, postSettings, statusLabel };
      if (canStreamPostDownloads(enabledHosts, postSettings)) {
        await runStreamingPostDownloads(run, resolutionOptions);
      } else {
        await runBufferedPostDownloads(run, resolutionOptions);
      }
      await finalizeDownloadArtifacts(run, customFilename);
      if (run.totalDownloadable > 0) {
        log.post.info(postId, postSettings.skipDownload ? '::Links generation completed::' : '::Download completed::', postNumber);
        callbacks?.onComplete?.(run.totalDownloadable, run.completed);
      }
    });
  } finally {
    window.logs = window.logs.filter(entry => entry.postId !== postId);
  }
};
