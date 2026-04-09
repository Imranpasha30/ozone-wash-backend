/**
 * Route Optimization Service
 * Uses Google Distance Matrix API to sort jobs by travel efficiency.
 * Falls back to Haversine nearest-neighbor if API key is missing.
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

// Nearest-neighbor TSP heuristic — O(n²), fine for ≤20 jobs
const nearestNeighbor = (jobs, startLat, startLng) => {
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

// Build optimized route using Distance Matrix API
const optimizeWithGoogleMaps = async (jobs, originLat, originLng) => {
  const destinations = jobs
    .map((j) => `${j.location_lat},${j.location_lng}`)
    .join('|');
  const origin = `${originLat},${originLng}`;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json`;

  // Get distance from current origin to all job locations
  const { data } = await axios.get(url, {
    params: {
      origins: origin,
      destinations,
      mode: 'driving',
      key: MAPS_KEY,
    },
    timeout: 5000,
  });

  if (data.status !== 'OK') throw new Error(`Maps API: ${data.status}`);

  // Sort jobs by distance from origin (greedy first leg)
  const elements = data.rows[0].elements;
  const withDist = jobs.map((j, i) => ({
    ...j,
    distance_km: elements[i]?.status === 'OK'
      ? Math.round(elements[i].distance.value / 100) / 10
      : null,
    duration_mins: elements[i]?.status === 'OK'
      ? Math.round(elements[i].duration.value / 60)
      : null,
  }));

  // Sort by distance ascending
  withDist.sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
  return withDist;
};

const RouteService = {
  /**
   * Given a list of jobs and technician's current location,
   * returns jobs sorted in optimized travel order.
   */
  optimizeRoute: async (jobs, originLat, originLng) => {
    // Filter jobs that have GPS coordinates
    const withCoords = jobs.filter(
      (j) => j.location_lat && j.location_lng &&
             parseFloat(j.location_lat) !== 0 && parseFloat(j.location_lng) !== 0
    );
    const withoutCoords = jobs.filter(
      (j) => !j.location_lat || !j.location_lng ||
             parseFloat(j.location_lat) === 0 || parseFloat(j.location_lng) === 0
    );

    if (withCoords.length === 0) {
      return { optimized: jobs, method: 'none', reason: 'No GPS coordinates on jobs' };
    }

    let optimized;
    let method;

    if (MAPS_KEY && originLat && originLng) {
      try {
        optimized = await optimizeWithGoogleMaps(withCoords, originLat, originLng);
        method = 'google_distance_matrix';
      } catch (err) {
        console.warn('⚠️ Google Maps fallback to Haversine:', err.message);
        optimized = nearestNeighbor(withCoords, originLat, originLng);
        method = 'haversine_fallback';
      }
    } else if (originLat && originLng) {
      optimized = nearestNeighbor(withCoords, originLat, originLng);
      method = 'haversine';
    } else {
      // No origin — sort by scheduled_at
      optimized = [...withCoords].sort(
        (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
      );
      method = 'chronological';
    }

    // Jobs without coords go at the end
    return {
      optimized: [...optimized, ...withoutCoords],
      method,
      total_jobs: jobs.length,
      optimized_count: withCoords.length,
    };
  },
};

module.exports = RouteService;
