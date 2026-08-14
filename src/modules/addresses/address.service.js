/**
 * Saved address book (Zomato/Swiggy-style).
 *
 * Each customer keeps addresses under a nickname label ("Home", "Office",
 * "Mom's house"). Bookings reference these for the primary location and for
 * per-tank locations. Deletes are soft so historical bookings stay readable.
 */
const db = require('../../config/db');

const MAX_ADDRESSES = 10;

const AddressService = {

  list: async (customerId) => {
    const { rows } = await db.query(
      `SELECT id, label, address, lat, lng, is_default, created_at, updated_at
         FROM customer_addresses
        WHERE customer_id = $1 AND deleted_at IS NULL
        ORDER BY is_default DESC, updated_at DESC`,
      [customerId]
    );
    return rows;
  },

  create: async (customerId, { label, address, lat, lng, is_default }) => {
    const { rows: existing } = await db.query(
      `SELECT COUNT(*)::int AS n FROM customer_addresses
        WHERE customer_id = $1 AND deleted_at IS NULL`,
      [customerId]
    );
    if (existing[0].n >= MAX_ADDRESSES) {
      throw { status: 400, message: `You can save up to ${MAX_ADDRESSES} addresses. Delete one first.` };
    }

    const makeDefault = is_default === true || existing[0].n === 0; // first address auto-default
    if (makeDefault) {
      await db.query(
        `UPDATE customer_addresses SET is_default = false, updated_at = NOW()
          WHERE customer_id = $1 AND deleted_at IS NULL`,
        [customerId]
      );
    }

    const { rows } = await db.query(
      `INSERT INTO customer_addresses (customer_id, label, address, lat, lng, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, label, address, lat, lng, is_default, created_at, updated_at`,
      [customerId, label.trim(), address.trim(), lat ?? null, lng ?? null, makeDefault]
    );
    return rows[0];
  },

  update: async (customerId, addressId, { label, address, lat, lng }) => {
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    if (label !== undefined)   { sets.push(`label = $${i++}`);   params.push(String(label).trim()); }
    if (address !== undefined) { sets.push(`address = $${i++}`); params.push(String(address).trim()); }
    if (lat !== undefined)     { sets.push(`lat = $${i++}`);     params.push(lat); }
    if (lng !== undefined)     { sets.push(`lng = $${i++}`);     params.push(lng); }

    params.push(customerId, addressId);
    const { rows } = await db.query(
      `UPDATE customer_addresses SET ${sets.join(', ')}
        WHERE customer_id = $${i++} AND id = $${i} AND deleted_at IS NULL
        RETURNING id, label, address, lat, lng, is_default, created_at, updated_at`,
      params
    );
    if (!rows.length) throw { status: 404, message: 'Address not found.' };
    return rows[0];
  },

  setDefault: async (customerId, addressId) => {
    await db.query(
      `UPDATE customer_addresses SET is_default = false, updated_at = NOW()
        WHERE customer_id = $1 AND deleted_at IS NULL`,
      [customerId]
    );
    const { rows } = await db.query(
      `UPDATE customer_addresses SET is_default = true, updated_at = NOW()
        WHERE customer_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id, label, address, lat, lng, is_default`,
      [customerId, addressId]
    );
    if (!rows.length) throw { status: 404, message: 'Address not found.' };
    return rows[0];
  },

  remove: async (customerId, addressId) => {
    const { rows } = await db.query(
      `UPDATE customer_addresses SET deleted_at = NOW(), is_default = false, updated_at = NOW()
        WHERE customer_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [customerId, addressId]
    );
    if (!rows.length) throw { status: 404, message: 'Address not found.' };
    return { deleted: true };
  },

};

module.exports = AddressService;
