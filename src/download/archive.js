const updateFinishedDownloadStatus = run => {
  const { statusUI, totalResources } = run;
  h.hide(statusUI.filePB);
  h.hide(statusUI.totalPB);
  if (run.completed < totalResources) {
    h.ui.setElProps(statusUI.status, { color: '#e8a838', fontWeight: 'bold' });
    h.ui.setText(statusUI.status, `${run.completed} / ${totalResources} downloaded`);
    h.show(statusUI.status);
  } else {
    h.hide(statusUI.status);
  }
};

// Read window.logs directly: lifecycle cleanup replaces the array.
const addGeneratedDownloadArtifacts = run => {
  const { postId, postNumber, postSettings, isFirefox, resolved, zip } = run;
  if (postSettings.generateLog) {
    log.post.info(postId, `::Generating log file::`, postNumber);
    zip.file(
      isFirefox ? 'generated/log.txt' : 'log.txt',
      (window.logs || [])
        .filter(l => l.postId === postId)
        .map(l => l.message)
        .join('\n'),
    );
  }
  if (postSettings.generateLinks) {
    log.post.info(postId, `::Generating links::`, postNumber);
    zip.file(
      isFirefox ? 'generated/links.txt' : 'links.txt',
      resolved
        .filter(r => r.url)
        .map(r => r.url)
        .join('\n'),
    );
  }
};

const generateDownloadArchiveBlob = async zip => {
  try {
    return await zip.generateAsync({ type: 'blob' });
  } catch (e) {
    console.log('JSZip failed to construct the Blob. For very large albums, try unzipped mode.');
    console.log(e);
    return null;
  }
};

const saveDownloadArchiveBlob = (blob, name, fallbackName, generatedOnly) =>
  new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const releaseUrl = () => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    };
    GM_download({
      url,
      name,
      onload: () => {
        releaseUrl();
        blob = null;
        resolve();
      },
      onerror: response => {
        releaseUrl();
        console.log(
          generatedOnly
            ? `Error writing generated.zip to disk. There may be more details below.`
            : `Error writing file to disk. There may be more details below.`,
        );
        console.log(response);
        if (generatedOnly) {
          blob = null;
        } else {
          console.log('Trying to write using FileSaver...');
          try {
            saveAs(blob, fallbackName);
          } catch (e) {}
          console.log('Done!');
        }
        resolve();
      },
    });
  });

const saveFinalDownloadArchive = async (blob, run, title, mainZipName, generatedZipName) => {
  const { postSettings, postNumber, isFirefox } = run;
  if (postSettings.zipped) {
    if (isFirefox) {
      saveAs(blob, mainZipName);
    } else {
      await saveDownloadArchiveBlob(blob, `${title}/#${postNumber}.zip`, mainZipName, false);
    }
  } else if (postSettings.generateLog || postSettings.generateLinks) {
    if (isFirefox) {
      saveAs(blob, generatedZipName);
    } else {
      await saveDownloadArchiveBlob(blob, `${title}/#${postNumber}/generated.zip`, generatedZipName, true);
    }
  }
};

const finalizeDownloadArtifacts = async (run, customFilename) => {
  const { postId, postNumber, postSettings, threadTitle, totalDownloadable, zip, zipFileCount } = run;
  updateFinishedDownloadStatus(run);
  if (!(totalDownloadable > 0)) return;

  const title = sanitizeWinSegment(threadTitle, settings?.naming);
  const mainZipName = customFilename || `${title} #${postNumber}.zip`;
  const generatedZipName = `${title} #${postNumber} generated.zip`;
  const needZipBlob = postSettings.generateLog || postSettings.generateLinks || (postSettings.zipped && zipFileCount > 0);

  // DIRECT-only runs may have no ZIP entries.
  if (postSettings.zipped && zipFileCount === 0 && !postSettings.generateLog && !postSettings.generateLinks) {
    log.post.info(postId, `::Zipped ON but nothing to zip (all DIRECT downloads) -> skipping ZIP::`, postNumber);
  }
  if (!needZipBlob) return;
  log.separator(postId);
  log.post.info(postId, postSettings.zipped ? `::Preparing zip::` : `::Preparing generated.zip::`, postNumber);
  addGeneratedDownloadArtifacts(run);
  const blob = await generateDownloadArchiveBlob(zip);
  if (!blob) return;

  await saveFinalDownloadArchive(blob, run, title, mainZipName, generatedZipName);
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { finalizeDownloadArtifacts };
}
