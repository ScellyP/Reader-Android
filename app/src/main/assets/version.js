/* =========================================================================
   App version marker
   =========================================================================
   This is the ONE place the version lives. It is shown at the bottom of the
   side menu. Nothing bumps it automatically — you edit APP_VERSION by hand.

   Format:  v MAJOR . MID . MINOR   e.g. v1.00.00

   MAJOR (the "1")   Stays put until YOU decide to change it.
   MID   (the middle) +1 for a major update (a new feature), OR when the minor
                      number would pass 99 (see below). The minor resets to 00.
   MINOR (the last)  +1 for every minor bug fix. After 99 fixes, roll over:
                      MID +1, MINOR back to 00 (v1.00.99 -> v1.01.00).

   Rules of thumb:
   - Broken builds NEVER change the version. If a build fails or you have to
     redo it, the number stays the same; only a real shipped fix/feature
     bumps it.
   - Bump the number in the same change as the fix/feature it describes.
   - This is separate from Android's versionCode/versionName in
     app/build.gradle (that one follows the GitHub Actions run number so
     updates install over each other). This is the human-facing number.

   >>> NOTE TO ANY AI ASSISTANT / FUTURE CHAT WORKING ON THIS PROJECT <<<
   Bumping this version is part of every change, and the owner should never
   have to ask for it. Whenever you fix a bug or add a feature in this
   project, update APP_VERSION below in the SAME change, following the rules
   above, and say the new version in your reply. Also update the README's
   "Version number" section if the rules themselves ever change. Do NOT bump
   for a build that failed or is being redone, or for changes that fix or
   add nothing (comments, docs, refactors).

   Examples:
     v1.00.00  first tracked version
     v1.00.01  fixed a small bug
     v1.01.00  added a feature
     v1.01.07  seven small fixes after that feature
     v2.00.00  you decided it's time for a new MAJOR
   ========================================================================= */
window.APP_VERSION = 'v1.04.01';

(function () {
  var el = document.getElementById('app-version');
  if (el) el.textContent = window.APP_VERSION;
})();
