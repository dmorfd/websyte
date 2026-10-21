// Scheduled (every minute, see netlify.toml) — not reachable by URL.
//
// Posts new comments on THIS site's photos in the shared gallery to this
// site's own Discord webhook (Admin → Gallery → Comment notifications). The
// gallery's server can't be told this site's webhook (the roster is not
// delegated), so this site asks it instead — see checkComments in
// lib/gallery-notify.js. Comments written on this site's own /gallery don't
// wait for this: the page triggers gallery-comment-check straight away.
const { checkCommentsOnce } = require('./lib/gallery-notify');

exports.handler = async () => {
  await checkCommentsOnce();
  return { statusCode: 200 };
};
