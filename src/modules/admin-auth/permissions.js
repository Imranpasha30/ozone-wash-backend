/**
 * Admin permission matrix.
 * Spec: Master Prompt v2.0 PART 2.2.2.
 *
 * Each admin_role has a default set of permissions. Individual admins can
 * have additional permissions appended via admin_users.permissions JSONB,
 * but the role grants act as a baseline.
 */

const ROLE_PERMISSIONS = {
  super_admin: [
    'admin.create',
    'admin.list',
    'admin.deactivate',
    'admin.revoke_sessions',
    'admin.audit_log',
    'booking.cancel',
    'crew.assign',
    'payout.view',
    'payout.approve',
    'refund.approve',
    'mis.view',
    'ecoscore.manage',
    'customer.view',
    'customer.edit',
  ],
  ops_manager: [
    'booking.cancel',
    'crew.assign',
    'payout.view',
    'mis.view',
    'ecoscore.manage',
    'customer.view',
  ],
  finance: [
    'payout.view',
    'refund.approve',
    'mis.view',
    'customer.view',
  ],
  support: [
    'booking.cancel',
    'customer.view',
  ],
  read_only: [
    'payout.view',
    'mis.view',
    'customer.view',
  ],
};

/**
 * Given an admin row (admin_role + permissions array), return the full
 * effective permission set as a Set for O(1) lookup.
 */
function effectivePermissions(admin) {
  const base = ROLE_PERMISSIONS[admin.admin_role] || [];
  const overrides = Array.isArray(admin.permissions) ? admin.permissions : [];
  return new Set([...base, ...overrides]);
}

function hasPermission(admin, permission) {
  return effectivePermissions(admin).has(permission);
}

module.exports = {
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
};
