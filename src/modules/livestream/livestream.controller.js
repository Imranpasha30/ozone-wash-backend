const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const { sendSuccess, sendError } = require('../../utils/response');

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '';

const LivestreamController = {

  // GET /api/v1/livestream/token?channel=<jobId>&role=publisher|subscriber
  getToken: async (req, res, next) => {
    try {
      const { channel, role } = req.query;
      if (!channel) return sendError(res, 'channel is required', 400);
      if (!APP_ID) return sendError(res, 'Agora not configured', 503);

      const uid = 0; // 0 = let Agora assign
      const expireTime = 3600; // 1 hour
      const currentTime = Math.floor(Date.now() / 1000);
      const privilegeExpire = currentTime + expireTime;

      const rtcRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

      // If no certificate, return App ID only (test mode)
      let token;
      if (!APP_CERTIFICATE) {
        token = null; // No certificate — app runs in test mode, token not required
      } else {
        token = RtcTokenBuilder.buildTokenWithUid(
          APP_ID, APP_CERTIFICATE, channel, uid, rtcRole, privilegeExpire
        );
      }

      return sendSuccess(res, {
        app_id: APP_ID,
        channel,
        token,
        uid,
        expire_at: privilegeExpire,
      });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = LivestreamController;
