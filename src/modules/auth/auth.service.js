// ONLY job: business logic. Calls repository for data.
const jwt = require('jsonwebtoken');
const AuthRepository = require('./auth.repository');
const NotificationService = require('../../services/notification.service');

/**
 * Demo / reviewer bypass accounts. Each entry maps a static phone to a static
 * OTP and the role the auto-provisioned user should land in. Used for:
 *   - Google Play Console reviewer login (customer slot)
 *   - Field-team demo login when a real technician phone isn't available
 *
 * All four env vars are optional — if any is unset the corresponding bypass
 * is dead code and the real OTP flow runs unchanged. The phone + OTP pair
 * MUST satisfy the controller's validation rules (phone matches
 * `^[6-9]\d{9}$` and OTP is a 6-digit numeric string).
 */
const buildBypassMap = () => {
  const map = {};
  if (process.env.REVIEWER_PHONE && process.env.REVIEWER_OTP) {
    map[process.env.REVIEWER_PHONE] = {
      otp: process.env.REVIEWER_OTP,
      role: 'customer',
      name: 'Play Reviewer',
    };
  }
  if (process.env.REVIEWER_FIELD_PHONE && process.env.REVIEWER_FIELD_OTP) {
    map[process.env.REVIEWER_FIELD_PHONE] = {
      otp: process.env.REVIEWER_FIELD_OTP,
      role: 'field_team',
      name: 'Field Demo',
    };
  }
  // AMC demo customer — lands as customer AND auto-enrolls into an active
  // AMC contract on first login so the demo flow shows AMC-member screens
  // (Premium tier eco hints, AMC dashboard chip on Profile, etc).
  if (process.env.REVIEWER_AMC_PHONE && process.env.REVIEWER_AMC_OTP) {
    map[process.env.REVIEWER_AMC_PHONE] = {
      otp: process.env.REVIEWER_AMC_OTP,
      role: 'customer',
      name: 'AMC Demo',
      autoAmc: process.env.REVIEWER_AMC_PLAN || 'quarterly',
    };
  }
  // Built-in app-store review account — ALWAYS available (Google Play + Apple
  // review sign-in), independent of any env config. Set last so it is
  // authoritative for this number. Plain customer role, no elevated access.
  map['9999999999'] = { otp: '999999', role: 'customer', name: 'App Review' };
  // Built-in CREW (field agent) review accounts — fixed phone + OTP for Play /
  // Apple review of the field-team app. Indian mobiles must start 6-9, so these
  // use repeated 6/7/8 + a 9-number (1xxx/2xxx/3xxx aren't valid numbers).
  map['6666666666'] = { otp: '666666', role: 'field_team', name: 'Review Crew 1' };
  map['7777777777'] = { otp: '777777', role: 'field_team', name: 'Review Crew 2' };
  map['8888888888'] = { otp: '888888', role: 'field_team', name: 'Review Crew 3' };
  map['9555555555'] = { otp: '555555', role: 'field_team', name: 'Review Crew 4' };
  return map;
};

// Lazily attach an active AMC contract to a user. Idempotent: skips if the
// user already has any active contract. Used by the bypass flow above when
// `autoAmc` is set on the entry.
async function ensureAmcContract(user_id, planType) {
  const { query } = require('../../config/db');
  // If they already have an active contract, leave it alone.
  const { rows: existing } = await query(
    `SELECT id FROM amc_contracts
       WHERE customer_id = $1 AND status = 'active' AND end_date > NOW()
       LIMIT 1`,
    [user_id]
  );
  if (existing[0]) return existing[0].id;

  const today = new Date();
  const endDate = new Date(today);
  endDate.setFullYear(endDate.getFullYear() + 1);
  // Demo pricing — round numbers for screenshot polish.
  const amountByPlan = {
    one_time:    350000,
    half_yearly: 630000,
    quarterly:   1260000,
    monthly:     5000000,
  };
  const amount = amountByPlan[planType] || amountByPlan.quarterly;

  const { rows } = await query(
    `INSERT INTO amc_contracts
       (customer_id, plan_type, start_date, end_date, status,
        amount_paise, payment_status, tank_ids)
     VALUES ($1, $2, $3::date, $4::date, 'active', $5, 'paid', '[]'::jsonb)
     RETURNING id`,
    [user_id, planType, today.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10), amount]
  );
  return rows[0].id;
}

const AuthService = {

  sendOtp: async (phone) => {
    // Reviewer bypass — see buildBypassMap comment.
    // For any phone listed in the bypass map, send-otp is a no-op (no DB row,
    // no SMS, no WhatsApp). The static OTP is accepted by verifyOtp below.
    const bypass = buildBypassMap();
    if (bypass[phone]) {
      console.log(`📱 Reviewer bypass: phone=${phone} (OTP=${bypass[phone].otp}) role=${bypass[phone].role}`);
      return { message: 'OTP sent successfully' };
    }

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Expires in 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Save to DB (replaces any existing unused OTP for this phone)
    await AuthRepository.saveOtp(phone, otpCode, expiresAt);

    // Always log OTP in development for easy testing without SMS credits
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📱 OTP for ${phone}: ${otpCode}`);
    }

    // Send via SMS and WhatsApp — both are fire-and-forget.
    // If API keys are not set, NotificationService falls back to console.log silently.
    await Promise.allSettled([
      NotificationService.sendOtp(phone, otpCode),
    ]);

    return { message: 'OTP sent successfully' };
  },

  verifyOtp: async (phone, otpCode, fcmToken = null) => {
    // Reviewer bypass — static phone + static OTP combo skips the OTP table
    // lookup and proceeds to find-or-create + JWT. Phone determines role
    // (customer or field_team) via the bypass map.
    const bypass = buildBypassMap();
    const entry = bypass[phone];
    if (entry && otpCode === entry.otp) {
      let user = await AuthRepository.findByPhone(phone);
      if (!user) {
        user = await AuthRepository.createUser({
          phone,
          role: entry.role,
          name: entry.name,
        });
      }
      // If the bypass entry asks for an auto-AMC, make sure this user has an
      // active contract. Fire-and-forget so a failure here never blocks login.
      if (entry.autoAmc) {
        ensureAmcContract(user.id, entry.autoAmc)
          .then((id) => console.log(`📜 AMC demo contract ensured: ${id} for ${phone}`))
          .catch((e) => console.warn('[auto-amc] failed:', e?.message));
      }
      if (fcmToken) {
        await AuthRepository.updateFcmToken(user.id, fcmToken);
      }
      const token = jwt.sign(
        { id: user.id, phone: user.phone, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
      return {
        token,
        user: {
          id: user.id,
          phone: user.phone,
          role: user.role,
          name: user.name,
          lang: user.lang,
        },
      };
    }

    // Check OTP is valid
    const validOtp = await AuthRepository.findValidOtp(phone, otpCode);

    if (!validOtp) {
      throw { status: 400, message: 'Invalid or expired OTP. Please request a new one.' };
    }

    // Mark OTP as used so it cannot be reused
    await AuthRepository.markOtpUsed(phone);

    // Find existing user or create new one
    let user = await AuthRepository.findByPhone(phone);
    if (!user) {
      user = await AuthRepository.createUser({ phone, role: 'customer' });
    }

    // Save FCM token if provided
    if (fcmToken) {
      await AuthRepository.updateFcmToken(user.id, fcmToken);
    }

    // Issue JWT
    const token = jwt.sign(
      { id: user.id, phone: user.phone, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        name: user.name,
        lang: user.lang,
      },
    };
  },

  updateProfile: async (userId, { name, email }) => {
    const user = await AuthRepository.updateProfile(userId, { name, email });
    if (!user) throw { status: 404, message: 'User not found.' };
    return user;
  },

  getProfile: async (userId) => {
    const user = await AuthRepository.findById(userId);
    if (!user) {
      throw { status: 404, message: 'User not found.' };
    }
    return user;
  },

  getAllUsers: async ({ role, limit, offset }) => {
    const [users, total] = await Promise.all([
      AuthRepository.findAllUsers({ role, limit, offset }),
      AuthRepository.countUsers(role),
    ]);
    return { users, total };
  },

};

module.exports = AuthService;