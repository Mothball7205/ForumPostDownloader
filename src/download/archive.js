// Read window.logs directly: lifecycle cleanup replaces the array.
const finalizeDownloadArtifacts = async (run, customFilename) => {
  const {
    postId,
    postNumber,
    postSettings,
    statusUI,
    threadTitle,
    isFirefox,
    resolved,
    totalDownloadable,
    totalResources,
    zip,
    zipFileCount,
  } = run;
  const statusLabel = statusUI.status;
  const filePB = statusUI.filePB;
  const totalPB = statusUI.totalPB;

  h.hide(filePB);
  h.hide(totalPB);
  if (run.completed < totalResources) {
    h.ui.setElProps(statusLabel, { color: '#e8a838', fontWeight: 'bold' });
    h.ui.setText(statusLabel, `${run.completed} / ${totalResources} downloaded`);
    h.show(statusLabel);
  } else {
    h.hide(statusLabel);
  }

  if (totalDownloadable > 0) {
    let title = sanitizeWinSegment(threadTitle, settings?.naming);

    const mainZipName = customFilename || `${title} #${postNumber}.zip`;
    const generatedZipName = `${title} #${postNumber} generated.zip`;
    const needZipBlob = postSettings.generateLog || postSettings.generateLinks || (postSettings.zipped && zipFileCount > 0);

    // DIRECT-only runs may have no ZIP entries.
    if (postSettings.zipped && zipFileCount === 0 && !postSettings.generateLog && !postSettings.generateLinks) {
      log.post.info(postId, `::Zipped ON but nothing to zip (all DIRECT downloads) -> skipping ZIP::`, postNumber);
    }
    if (needZipBlob) {
      log.separator(postId);
      log.post.info(postId, postSettings.zipped ? `::Preparing zip::` : `::Preparing generated.zip::`, postNumber);

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

      let blob = null;
      try {
        blob = await zip.generateAsync({ type: 'blob' });
      } catch (e) {
        console.log('JSZip failed to construct the Blob. For very large albums, try unzipped mode.');
        console.log(e);
        blob = null;
      }

      if (blob) {
        if (postSettings.zipped) {
          if (isFirefox) {
            saveAs(blob, mainZipName);
          } else {
            await new Promise(resolve => {
              const url = URL.createObjectURL(blob);
              GM_download({
                url,
                name: `${title}/#${postNumber}.zip`,
                onload: () => {
                  try {
                    URL.revokeObjectURL(url);
                  } catch (e) {}
                  blob = null;
                  resolve();
                },
                onerror: response => {
                  try {
                    URL.revokeObjectURL(url);
                  } catch (e) {}
                  console.log(`Error writing file to disk. There may be more details below.`);
                  console.log(response);
                  console.log('Trying to write using FileSaver...');
                  try {
                    saveAs(blob, mainZipName);
                  } catch (e) {}
                  console.log('Done!');
                  resolve();
                },
              });
            });
          }
        } else {
          if (postSettings.generateLog || postSettings.generateLinks) {
            if (isFirefox) {
              saveAs(blob, generatedZipName);
            } else {
              await new Promise(resolve => {
                const url = URL.createObjectURL(blob);
                GM_download({
                  url,
                  name: `${title}/#${postNumber}/generated.zip`,
                  onload: () => {
                    try {
                      URL.revokeObjectURL(url);
                    } catch (e) {}
                    blob = null;
                    resolve();
                  },
                  onerror: response => {
                    try {
                      URL.revokeObjectURL(url);
                    } catch (e) {}
                    console.log(`Error writing generated.zip to disk. There may be more details below.`);
                    console.log(response);
                    blob = null;
                    resolve();
                  },
                });
              });
            }
          }
        }
      }
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { finalizeDownloadArtifacts };
}
