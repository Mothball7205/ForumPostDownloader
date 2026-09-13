# Forum Posts Downloader
This Tampermonkey script allows for downloading individual posts and pages from the SimpCity forum (should work for any XenForo forum).


##  Installation
1. Install the Tampermonkey browser extension: [Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=en) [Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) [Brave](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo?hl=en)
2. **Important:** Under the tampermonkey settings, set the **Config mode** to **Advanced** and enable the **Browser API** in **Download Mode (BETA)**.
3. Copy the contents of [the fork's userscript](https://github.com/Mothball7205/ForumPostDownloader/blob/main/dist/build.user.js).
4. Create a new Tampermonkey script and paste the contents you copied in step 3 (build.user.js).
5. Save the script (Ctrl+S).
6. Visit any thread to verify the script installation.

# Updates
The script should automatically update from GitHub. If it doesn't simply repeat the steps 3-6 from the installation section (paste into the existing script instead of creating a new one (step #4)).

## Development

- `bun run format` formats source and tests, then rebuilds the userscript.
- `bun run format:check` checks formatting without modifying files.
- `bun run lint` rebuilds the userscript and runs ESLint plus selected SonarJS rules.
- `bun test` runs regression tests.

Lint errors fail CI. Complexity, duplication, dead-store, and unused-variable warnings are advisory; no automatic lint fixes run. Shared-global name checks run on the assembled userscript, while code-smell diagnostics point to source files. Edit `src`, not `dist/build.user.js`.
