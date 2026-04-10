/**
 * Route Optimization Service
 *
 * Priority:  1. Appointment time (scheduled_at) — always respected
 *            2. Distance — used ONLY to reorder jobs within the same time slot
 *
 * Why: a 4 PM job 1 km away must never jump ahead of a 10 AM job 5 km away.
 * Distance Matrix / Haversine is used to add travel context and to sort ties.
 */
const axios = require('axios');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Haversine distance in km between two lat/lng points
const haversine = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Group jobs that fall within `windowMins` of each other into slots
// e.g. 10:00 and 10:20 → same slot if windowMins=30
const groupByTimeSlot = (jobs, windowMins = 30) => {
  const sorted = [...jobs].sort(
    (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
  );

  const groups = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].scheduled_at).getTime();
    const curr = new Date(sorted[i].scheduled_at).getTime();
    const diffMins = (curr - prev) / 60000;
    if (diffMins <= windowMins) {
      current.push(sorted[i]);
    } else {
      groups.push(current);
      current = [sorted[i]];
    }
  }
  groups.push(current);
  return groups;
};

// Within a group of same-slot jobs, pick nearest-neighbor order from a start point
const nearestNeighborGroup = (jobs, startLat, startLng) => {
  if (jobs.length <= 1) return jobs;
  const unvisited = [...jobs];
  const route = [];
  let curLat = startLat;
  let curLng = startLng;

  while (unvisited.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    unvisited.forEach((j, i) => {
      const lat = parseFloat(j.location_lat || 0);
      const lng = parseFloat(j.location_lng || 0);
      const d = haversine(curLat, curLng, lat, lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const next = unvisited.splice(bestIdx, 1)[0];
    route.push({ ...next, distance_km: Math.round(bestDist * 10) / 10 });
    curLat = parseFloat(next.location_lat || curLat);
    curLng = parseFloat(next.location_lng || curLng);
  }
  return route;
};

// Annotate jobs with Google distance/duration from a single origin
const annotateWithGoogleDistance = async (jobs, originLat, originLng) => {
  const destinations = jobs.map((j) => `${j.location_lat},${j.location_lng}`).join('|');
  const { data } = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
    params: {
      origins: `${originLat},${originLng}`,
      destinations,
      mode: 'driving',
      key: MAPS_KEY,
    },
    timeout: 5000,
  });

  if (data.status !== 'OK') throw new Error(`Maps API: ${data.status}`);

  const elements = data.rows[0].elements;
  return jobs.map((j, i) => ({
    ...j,
    distance_km: elements[i]?.status === 'OK'
      ? Math.round(elements[i].distance.value / 100) / 10
      : null,
    duration_mins: elements[i]?.status === 'OK'
      ? Math.round(elements[i].duration.value / 60)
      : null,
  }));
};

const RouteService = {
  /**
   * Returns jobs sorted by appointment time first.
   * Within the same time slot (±30 min), orders by travel distance.
   */
  optimizeRoute: async (jobs, originLat, originLng) => {
    const withCoords = jobs.filter(
      (j) => j.location_lat && j.location_lng &&
             parseFloat(j.location_lat) !== 0 && parseFloat(j.location_lng) !== 0
    );
    const withoutCoords = jobs.filter(
      (j) => !j.location_lat || !j.location_lng ||
             parseFloat(j.location_lat) === 0 || parseFloat(j.location_lng) === 0
    );

    // No GPS on jobs — just sort by time
    if (withCoords.length === 0) {
      const chronological = [...jobs].sort(
        (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
      );
      return { optimized: chronological, method: 'chronological', reason: 'No GPS coordinates on jobs' };
    }

    // Step 1: annotate jobs with distance info (best effort)
    let annotated = withCoords;
    let method = 'time_first';

    if (originLat && originLng) {
      if (MAPS_KEY) {
        try {
          annotated = await annotateWithGoogleDistance(withCoords, originLat, originLng);
          method = 'time_first+google_distance';
        } catch (err) {
          console.warn('⚠️ Google Maps fallback to Haversine:', err.message);
          // Annotate with haversine distance
          annotated = withCoords.map((j) => ({
            ...j,
            distance_km: Math.round(
              haversine(originLat, originLng, parseFloat(j.location_lat), parseFloat(j.location_lng)) * 10
            ) / 10,
          }));
          method = 'time_first+haversine';
        }
      } else {
        // No API key — haversine annotation only
        annotated = withCoords.map((j) => ({
          ...j,
          distance_km: Math.round(
            haversine(originLat, originLng, parseFloat(j.location_lat), parseFloat(j.location_lng)) * 10
          ) / 10,
        }));
        method = 'time_first+haversine';
      }
    }

    // Step 2: group by time slot (±30 min window)
    const groups = groupByTimeSlot(annotated, 30);

    // Step 3: within each slot group, optimize by distance
    let curLat = originLat || 0;
    let curLng = originLng || 0;
    const optimized = [];

    for (const group of groups) {
      const ordered = (originLat && originLng)
        ? nearestNeighborGroup(group, curLat, curLng)
        : group;

      optimized.push(...ordered);

      // Update current position to last job in this group
      const last = ordered[ordered.length - 1];
      curLat = parseFloat(last.location_lat || curLat);
      curLng = parseFloat(last.location_lng || curLng);
    }

    // Jobs without coords go at the end, sorted by time
    const tail = [...withoutCoords].sort(
      (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
    );

    return {
      optimized: [...optimized, ...tail],
      method,
      total_jobs: jobs.length,
      optimized_count: withCoords.length,
    };
  },
};

module.exports = RouteService;
