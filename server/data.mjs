// SANDTABLE seed content: theater geography, scenarios (ORBATs), rule sets,
// agents, missions, COAs, platform info, users and audit seed. All content is
// fictional (Meridian Archipelago / Exercise AZURE HORIZON). Shapes mirror
// src/types.ts exactly. All randomness is a seeded mulberry32 PRNG so every
// boot produces the identical theater.

import { buildOntology } from "./ontology.mjs";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const KM_PER_DEG_LAT = 111;
const KM_PER_DEG_LNG = 92; // at ~34° N

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round4 = (n) => Math.round(n * 10000) / 10000;
const wp = (lat, lng) => ({ lat, lng });
const sensor = (type, rangeKm) => ({ type, rangeKm });
const weapon = (type, rangeKm, pk, ammo) => ({ type, rangeKm, pk, ammo });

/**
 * Deterministic irregular coastline ring around a center point.
 * Radius varies 62-106% per vertex so islands read as hand-drawn.
 */
function coastline(seed, centerLat, centerLng, radiusKm, vertexCount, stretchLng = 1) {
  const rng = mulberry32(seed);
  const ring = [];
  for (let i = 0; i < vertexCount; i++) {
    const theta = (2 * Math.PI * i) / vertexCount;
    const radial = radiusKm * (0.62 + 0.44 * rng());
    ring.push(
      wp(
        round4(centerLat + (Math.sin(theta) * radial) / KM_PER_DEG_LAT),
        round4(centerLng + (Math.cos(theta) * radial * stretchLng) / KM_PER_DEG_LNG)
      )
    );
  }
  return ring;
}

function unit(id, side, name, classId, domain, lat, lng, opts = {}) {
  const {
    headingDeg = 90,
    speedKts = 0,
    strength = 100,
    supply = 90,
    sensors = [],
    weapons = [],
    status = "active",
    taskForce,
    notes,
  } = opts;
  const u = {
    id,
    side,
    name,
    classId,
    domain,
    position: wp(lat, lng),
    headingDeg,
    speedKts,
    strength,
    supply,
    sensors,
    weapons,
    status,
  };
  if (taskForce) u.taskForce = taskForce;
  if (notes) u.notes = notes;
  return u;
}

const cond = (fact, op, value) => ({ fact, op, value });
const fx = (type, params = {}) => ({ type, params });
const rule = (id, name, category, description, conditions, effects, priority, enabled = true) => ({
  id,
  name,
  category,
  description,
  conditions,
  effects,
  priority,
  enabled,
});

// --------------------------------------------------------------------------
// Theater, the Meridian Archipelago
// --------------------------------------------------------------------------

export function buildTheater() {
  return [
    {
      id: "thf-monte-meridian",
      name: "Monte Meridian",
      kind: "island",
      polygon: coastline(101, 34.1, -39.55, 32, 13, 1.15),
    },
    {
      id: "thf-ilha-norte",
      name: "Ilha Norte",
      kind: "island",
      polygon: coastline(102, 34.95, -40.15, 14, 10, 1.05),
    },
    {
      id: "thf-vela-do-sul",
      name: "Vela do Sul",
      kind: "island",
      polygon: coastline(103, 33.3, -39.85, 15, 11, 0.85),
    },
    {
      id: "thf-ponta-oeste",
      name: "Ponta Oeste",
      kind: "island",
      polygon: coastline(104, 33.95, -40.7, 10, 9, 1.0),
    },
    {
      id: "thf-recife-leste",
      name: "Recife Leste",
      kind: "island",
      polygon: coastline(105, 34.35, -38.75, 11, 9, 1.2),
    },
    {
      id: "thf-serpent-shoal",
      name: "Serpent Shoal",
      kind: "shoal",
      polygon: coastline(106, 33.65, -40.35, 12, 8, 1.6),
    },
    {
      id: "thf-halfmoon-bank",
      name: "Half-Moon Bank",
      kind: "shoal",
      polygon: coastline(107, 34.55, -39.35, 9, 8, 1.2),
    },
    {
      id: "thf-strait-corridor",
      name: "Meridian Strait transit corridor",
      kind: "zone",
      polygon: [wp(34.18, -40.5), wp(34.18, -40.05), wp(33.98, -40.0), wp(33.82, -40.18), wp(33.84, -40.5)],
    },
    {
      id: "thf-red-warning-area",
      name: "RED declared warning area",
      kind: "zone",
      polygon: [
        wp(35.1, -40.3),
        wp(35.05, -38.6),
        wp(34.2, -38.3),
        wp(33.4, -38.8),
        wp(33.05, -39.9),
        wp(33.6, -40.35),
        wp(34.4, -40.3),
      ],
    },
  ];
}

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

function azureBlueUnits() {
  const CSG = "CTF-70 Sword";
  const ARG = "CTF-76 Gate";
  return [
    unit("blu-cvn-01", "blue", "CVN 79 Vigilant", "maritime.carrier", "sea", 34.05, -42.9, {
      speedKts: 16,
      supply: 92,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 160), sensor("surface-search-radar", 45)],
      weapons: [weapon("sam", 30, 0.5, 24), weapon("gun", 15, 0.25, 20)],
      notes: "Task force flagship. Loss ends coalition air superiority.",
    }),
    unit("blu-ddg-01", "blue", "DDG 114 Halberd", "maritime.destroyer", "sea", 34.18, -42.78, {
      speedKts: 18,
      supply: 88,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 180), sensor("surface-search-radar", 55), sensor("sonar", 28)],
      weapons: [weapon("sam", 150, 0.65, 32), weapon("ssm", 180, 0.55, 8), weapon("torpedo", 15, 0.45, 6), weapon("gun", 20, 0.3, 30)],
      notes: "Air-defense commander, northern screen sector.",
    }),
    unit("blu-ddg-02", "blue", "DDG 121 Warhammer", "maritime.destroyer", "sea", 33.92, -42.78, {
      speedKts: 18,
      supply: 90,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 175), sensor("surface-search-radar", 55), sensor("sonar", 28)],
      weapons: [weapon("sam", 150, 0.65, 32), weapon("ssm", 180, 0.55, 8), weapon("torpedo", 15, 0.45, 6), weapon("gun", 20, 0.3, 30)],
      notes: "Southern screen sector.",
    }),
    unit("blu-ffg-01", "blue", "FFG 62 Corsair", "maritime.frigate", "sea", 34.05, -42.6, {
      speedKts: 16,
      supply: 86,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 120), sensor("surface-search-radar", 50), sensor("sonar", 32)],
      weapons: [weapon("sam", 50, 0.55, 16), weapon("ssm", 140, 0.5, 8), weapon("torpedo", 15, 0.45, 6)],
      notes: "Forward picket ahead of the main body.",
    }),
    unit("blu-ffg-02", "blue", "FFG 66 Talisman", "maritime.frigate", "sea", 34.05, -43.15, {
      speedKts: 16,
      supply: 87,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 120), sensor("surface-search-radar", 50), sensor("sonar", 32)],
      weapons: [weapon("sam", 50, 0.55, 16), weapon("ssm", 140, 0.5, 8), weapon("torpedo", 15, 0.45, 6)],
      notes: "ASW screen astern, covers the amphibious group.",
    }),
    unit("blu-ssn-01", "blue", "SSN 792 Shadowfin", "maritime.submarine", "sea", 34.0, -42.2, {
      speedKts: 12,
      supply: 94,
      taskForce: CSG,
      sensors: [sensor("sonar", 40), sensor("esm", 60)],
      weapons: [weapon("torpedo", 30, 0.65, 10), weapon("ssm", 120, 0.5, 6)],
      notes: "Submerged forward picket on the strait axis.",
    }),
    unit("blu-lha-01", "blue", "LHA 9 Bastion", "maritime.amphibious", "sea", 34.15, -43.25, {
      speedKts: 14,
      supply: 91,
      taskForce: ARG,
      sensors: [sensor("air-search-radar", 110), sensor("surface-search-radar", 40)],
      weapons: [weapon("sam", 25, 0.45, 16), weapon("gun", 15, 0.25, 20)],
      notes: "Carries 1st Bn / 5th Coalition Marines.",
    }),
    unit("blu-aor-01", "blue", "AOR 58 Sustainer", "maritime.auxiliary", "sea", 33.9, -43.3, {
      speedKts: 12,
      supply: 100,
      taskForce: ARG,
      sensors: [sensor("surface-search-radar", 40)],
      weapons: [weapon("gun", 15, 0.2, 12)],
      notes: "Underway replenishment station for the task force.",
    }),
    unit("blu-vfa-01", "blue", "VFA-113 Reapers", "air.fighter-squadron", "air", 34.35, -42.55, {
      speedKts: 95,
      supply: 84,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 130)],
      weapons: [weapon("aam", 95, 0.6, 24), weapon("gun", 15, 0.3, 18)],
      notes: "Northern combat air patrol station.",
    }),
    unit("blu-vfa-02", "blue", "VFA-87 Peregrines", "air.fighter-squadron", "air", 33.75, -42.55, {
      speedKts: 95,
      supply: 84,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 130)],
      weapons: [weapon("aam", 95, 0.6, 24), weapon("gun", 15, 0.3, 18)],
      notes: "Southern combat air patrol station.",
    }),
    unit("blu-vsq-01", "blue", "VFA-151 Hammerfall", "air.strike-squadron", "air", 34.05, -43.0, {
      speedKts: 90,
      supply: 82,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 90), sensor("esm", 120)],
      weapons: [weapon("strike", 280, 0.55, 16), weapon("aam", 60, 0.45, 8)],
      notes: "Standoff strike and SEAD tasking.",
    }),
    unit("blu-aew-01", "blue", "CAW-5 Longwatch", "air.aew", "air", 34.1, -42.6, {
      speedKts: 80,
      supply: 88,
      taskForce: CSG,
      sensors: [sensor("air-search-radar", 170), sensor("surface-search-radar", 150)],
      weapons: [],
      notes: "AEW&C orbit extending the force radar horizon.",
    }),
    unit("blu-mpa-01", "blue", "VP-40 Trident Ray", "air.maritime-patrol", "air", 33.55, -42.7, {
      speedKts: 75,
      supply: 86,
      taskForce: ARG,
      sensors: [sensor("surface-search-radar", 130), sensor("sonar", 60), sensor("esm", 140)],
      weapons: [weapon("torpedo", 20, 0.5, 4), weapon("ssm", 90, 0.45, 2)],
      notes: "Wide-area surface search and ASW barrier, southwest sector.",
    }),
    unit("blu-uav-01", "blue", "UAV-7 Sandpiper", "air.uav-recon", "air", 34.4, -42.2, {
      speedKts: 65,
      supply: 95,
      taskForce: CSG,
      sensors: [sensor("surface-search-radar", 100), sensor("eo-ir", 45)],
      weapons: [],
      notes: "Persistent reconnaissance orbit, pushes ahead of the force.",
    }),
    unit("blu-mar-01", "blue", "1st Bn / 5th Coalition Marines", "land.marine-battalion", "land", 34.15, -43.25, {
      speedKts: 8,
      supply: 96,
      taskForce: ARG,
      sensors: [sensor("ground-surveillance", 20)],
      weapons: [weapon("gun", 15, 0.35, 36)],
      notes: "Embarked aboard LHA 9 Bastion until the assault phase.",
    }),
    unit("blu-cyb-01", "blue", "Joint Cyber Effects Cell", "cyber.ops-cell", "cyber", 34.05, -42.9, {
      speedKts: 0,
      headingDeg: 0,
      supply: 90,
      taskForce: CSG,
      sensors: [sensor("network-monitor", 60)],
      weapons: [weapon("cyber-effect", 300, 0.3, 6)],
      notes: "Embarked with the flagship; tasked against RED C2 and IADS networks.",
    }),
  ];
}

function azureRedUnits() {
  const IADS = "IADS Meridian";
  const CDG = "Coastal Defense Group";
  const FLOT = "4th Patrol Flotilla";
  return [
    unit("red-cdcm-01", "red", "1st Coastal Missile Battery", "land.coastal-battery", "land", 33.95, -40.7, {
      headingDeg: 270,
      supply: 82,
      taskForce: CDG,
      sensors: [sensor("surface-search-radar", 90), sensor("esm", 120)],
      weapons: [weapon("ssm", 180, 0.6, 12)],
      notes: "Emplaced on Ponta Oeste covering the western strait approach.",
    }),
    unit("red-cdcm-02", "red", "2nd Coastal Missile Battery", "land.coastal-battery", "land", 34.04, -39.76, {
      headingDeg: 270,
      supply: 80,
      taskForce: CDG,
      sensors: [sensor("surface-search-radar", 80)],
      weapons: [weapon("ssm", 160, 0.55, 12)],
      notes: "Western slope of Monte Meridian, second layer of the strait defense.",
    }),
    unit("red-sam-01", "red", "401st SAM Battalion", "land.sam-battalion", "land", 34.12, -39.55, {
      headingDeg: 0,
      supply: 85,
      taskForce: IADS,
      sensors: [sensor("air-search-radar", 190)],
      weapons: [weapon("sam", 120, 0.55, 24)],
      notes: "Long-range area SAM, centerpiece of the IADS on Monte Meridian.",
    }),
    unit("red-sam-02", "red", "402nd SAM Battalion", "land.sam-battalion", "land", 34.94, -40.14, {
      headingDeg: 0,
      supply: 78,
      taskForce: IADS,
      sensors: [sensor("air-search-radar", 140)],
      weapons: [weapon("sam", 70, 0.5, 16)],
      notes: "Medium-range SAM covering the northern axis from Ilha Norte.",
    }),
    unit("red-rdr-01", "red", "Vela do Sul EW Radar Site", "facility.radar-site", "land", 33.3, -39.84, {
      headingDeg: 0,
      supply: 88,
      taskForce: IADS,
      sensors: [sensor("air-search-radar", 240), sensor("surface-search-radar", 130)],
      weapons: [],
      notes: "Early-warning node cueing the SAM battalions and coastal batteries.",
    }),
    unit("red-rdr-02", "red", "Recife Leste Surveillance Site", "facility.radar-site", "land", 34.35, -38.75, {
      headingDeg: 0,
      supply: 86,
      taskForce: IADS,
      sensors: [sensor("air-search-radar", 170), sensor("surface-search-radar", 150)],
      weapons: [],
      notes: "Eastern coastal surveillance radar.",
    }),
    unit("red-pgm-01", "red", "P-311 Krait", "maritime.missile-boat", "sea", 33.85, -40.12, {
      headingDeg: 200,
      speedKts: 26,
      supply: 76,
      taskForce: FLOT,
      sensors: [sensor("surface-search-radar", 70), sensor("esm", 90)],
      weapons: [weapon("ssm", 90, 0.5, 4), weapon("gun", 15, 0.25, 12)],
      notes: "Strait picket, loiters under coastal battery cover.",
    }),
    unit("red-pgm-02", "red", "P-314 Adder", "maritime.missile-boat", "sea", 34.62, -40.05, {
      headingDeg: 320,
      speedKts: 26,
      supply: 78,
      taskForce: FLOT,
      sensors: [sensor("surface-search-radar", 70), sensor("esm", 90)],
      weapons: [weapon("ssm", 90, 0.5, 4), weapon("gun", 15, 0.25, 12)],
      notes: "Northern channel picket between Monte Meridian and Ilha Norte.",
    }),
    unit("red-cor-01", "red", "Corvette Vortex", "maritime.corvette", "sea", 34.2, -39.05, {
      headingDeg: 180,
      speedKts: 20,
      supply: 84,
      taskForce: FLOT,
      sensors: [sensor("surface-search-radar", 100), sensor("air-search-radar", 80), sensor("sonar", 18)],
      weapons: [weapon("ssm", 120, 0.55, 8), weapon("sam", 25, 0.4, 12), weapon("torpedo", 15, 0.4, 4), weapon("gun", 15, 0.25, 16)],
      notes: "Flotilla flagship holding east of Monte Meridian.",
    }),
    unit("red-cor-02", "red", "Corvette Cyclone", "maritime.corvette", "sea", 33.55, -39.3, {
      headingDeg: 240,
      speedKts: 20,
      supply: 83,
      taskForce: FLOT,
      sensors: [sensor("surface-search-radar", 100), sensor("air-search-radar", 80), sensor("sonar", 18)],
      weapons: [weapon("ssm", 120, 0.55, 8), weapon("sam", 25, 0.4, 12), weapon("torpedo", 15, 0.4, 4), weapon("gun", 15, 0.25, 16)],
      notes: "Southeast patrol sector, covers Vela do Sul.",
    }),
    unit("red-ssk-01", "red", "S-201 Murena", "maritime.submarine", "sea", 33.7, -40.7, {
      headingDeg: 270,
      speedKts: 6,
      supply: 90,
      taskForce: FLOT,
      sensors: [sensor("sonar", 35), sensor("esm", 50)],
      weapons: [weapon("torpedo", 25, 0.65, 8), weapon("ssm", 100, 0.5, 4)],
      notes: "Diesel-electric ambusher southwest of the strait mouth.",
    }),
    unit("red-fs-01", "red", "22nd Interceptor Squadron", "air.fighter-squadron", "air", 34.16, -39.47, {
      headingDeg: 270,
      speedKts: 100,
      supply: 80,
      taskForce: IADS,
      sensors: [sensor("air-search-radar", 110)],
      weapons: [weapon("aam", 80, 0.55, 20), weapon("gun", 15, 0.3, 12)],
      notes: "Ready alert over the Monte Meridian airstrip.",
    }),
    unit("red-art-01", "red", "310th Artillery Battalion", "land.artillery", "land", 33.99, -39.63, {
      headingDeg: 270,
      supply: 75,
      taskForce: CDG,
      sensors: [sensor("ground-surveillance", 25)],
      weapons: [weapon("gun", 45, 0.45, 36)],
      notes: "Rocket and tube artillery registered on the western beaches.",
    }),
    unit("red-dep-01", "red", "Meridian Logistics Depot", "facility.logistics-depot", "land", 34.18, -39.44, {
      headingDeg: 0,
      supply: 100,
      taskForce: "Garrison Sustainment",
      sensors: [sensor("surface-search-radar", 25)],
      weapons: [weapon("sam", 15, 0.3, 8)],
      notes: "Fuel and munitions hub sustaining every island garrison.",
    }),
    unit("red-hq-01", "red", "OPFOR Joint Command Post", "facility.command-post", "land", 34.14, -39.5, {
      headingDeg: 0,
      supply: 92,
      taskForce: IADS,
      sensors: [sensor("esm", 220), sensor("ground-surveillance", 20)],
      weapons: [],
      notes: "Hardened joint command node fusing the RED recognized picture.",
    }),
  ];
}

function azureObjectives() {
  return [
    {
      id: "obj-az-strait",
      side: "blue",
      title: "Secure the Meridian Strait",
      description: "Establish sea control of the strait transit corridor so coalition shipping can pass unmolested.",
      kind: "control-area",
      area: { center: wp(34.0, -40.3), radiusKm: 45 },
      weight: 0.3,
    },
    {
      id: "obj-az-iads",
      side: "blue",
      title: "Dismantle the RED IADS",
      description: "Destroy or suppress the SAM battalions and early-warning radars anchoring the RED integrated air defense.",
      kind: "destroy",
      targetUnitIds: ["red-sam-01", "red-sam-02", "red-rdr-01", "red-rdr-02"],
      weight: 0.3,
    },
    {
      id: "obj-az-carrier",
      side: "blue",
      title: "Preserve the flagship",
      description: "Keep CVN 79 Vigilant combat-effective; her air wing underwrites the entire operation.",
      kind: "protect",
      targetUnitIds: ["blu-cvn-01"],
      weight: 0.2,
    },
    {
      id: "obj-az-landing",
      side: "blue",
      title: "Land the marine battalion",
      description: "Put 1st Bn / 5th Coalition Marines ashore on the western beach of Monte Meridian and hold the beachhead.",
      kind: "deliver",
      area: { center: wp(34.02, -39.92), radiusKm: 15 },
      targetUnitIds: ["blu-mar-01"],
      weight: 0.2,
    },
    {
      id: "obj-az-red-deny",
      side: "red",
      title: "Deny strait passage",
      description: "Keep coalition shipping out of the Meridian Strait through layered coastal and sub-surface defense.",
      kind: "deny",
      area: { center: wp(33.95, -40.35), radiusKm: 50 },
      weight: 0.4,
    },
    {
      id: "obj-az-red-carrier",
      side: "red",
      title: "Cripple the BLUE carrier",
      description: "Mass missile salvos against CVN 79 Vigilant to break the coalition air campaign.",
      kind: "destroy",
      targetUnitIds: ["blu-cvn-01"],
      weight: 0.35,
    },
    {
      id: "obj-az-red-protect",
      side: "red",
      title: "Protect joint command and sustainment",
      description: "Preserve the joint command post and the Meridian logistics depot on Monte Meridian.",
      kind: "protect",
      targetUnitIds: ["red-hq-01", "red-dep-01"],
      weight: 0.25,
    },
  ];
}

function straitGuardianUnits() {
  const CONVOY = "Convoy MERIDIAN-7";
  return [
    unit("blu-sg-ddg-01", "blue", "DDG 118 Vanguard", "maritime.destroyer", "sea", 33.25, -42.35, {
      headingDeg: 60,
      speedKts: 16,
      supply: 89,
      taskForce: CONVOY,
      sensors: [sensor("air-search-radar", 170), sensor("surface-search-radar", 50), sensor("sonar", 26)],
      weapons: [weapon("sam", 140, 0.6, 28), weapon("ssm", 160, 0.5, 8), weapon("torpedo", 15, 0.45, 4)],
      notes: "Convoy escort commander.",
    }),
    unit("blu-sg-ffg-01", "blue", "FFG 58 Palisade", "maritime.frigate", "sea", 33.15, -42.55, {
      headingDeg: 60,
      speedKts: 16,
      supply: 85,
      taskForce: CONVOY,
      sensors: [sensor("air-search-radar", 115), sensor("surface-search-radar", 48), sensor("sonar", 30)],
      weapons: [weapon("sam", 50, 0.55, 16), weapon("ssm", 140, 0.5, 8), weapon("torpedo", 15, 0.45, 6)],
    }),
    unit("blu-sg-ffg-02", "blue", "FFG 60 Rampart", "maritime.frigate", "sea", 33.35, -42.55, {
      headingDeg: 60,
      speedKts: 16,
      supply: 85,
      taskForce: CONVOY,
      sensors: [sensor("air-search-radar", 115), sensor("surface-search-radar", 48), sensor("sonar", 30)],
      weapons: [weapon("sam", 50, 0.55, 16), weapon("ssm", 140, 0.5, 8), weapon("torpedo", 15, 0.45, 6)],
    }),
    unit("blu-sg-mer-01", "blue", "MV Coral Meridian", "maritime.auxiliary", "sea", 33.22, -42.5, {
      headingDeg: 60,
      speedKts: 14,
      supply: 100,
      taskForce: CONVOY,
      sensors: [sensor("surface-search-radar", 25)],
      weapons: [],
      notes: "Chartered sealift, priority cargo.",
    }),
    unit("blu-sg-mer-02", "blue", "MV Anselm Trader", "maritime.auxiliary", "sea", 33.28, -42.58, {
      headingDeg: 60,
      speedKts: 14,
      supply: 100,
      taskForce: CONVOY,
      sensors: [sensor("surface-search-radar", 25)],
      weapons: [],
      notes: "Chartered sealift.",
    }),
    unit("blu-sg-mer-03", "blue", "MV Pelican Star", "maritime.auxiliary", "sea", 33.18, -42.66, {
      headingDeg: 60,
      speedKts: 14,
      supply: 100,
      taskForce: CONVOY,
      sensors: [sensor("surface-search-radar", 25)],
      weapons: [],
      notes: "Chartered sealift.",
    }),
    unit("blu-sg-mpa-01", "blue", "VP-46 Grey Heron", "air.maritime-patrol", "air", 33.5, -42.6, {
      headingDeg: 60,
      speedKts: 75,
      supply: 88,
      taskForce: CONVOY,
      sensors: [sensor("surface-search-radar", 110), sensor("sonar", 55), sensor("esm", 120)],
      weapons: [weapon("torpedo", 20, 0.5, 4)],
      notes: "ASW sweep ahead of the convoy track.",
    }),
    unit("red-sg-ssk-01", "red", "S-203 Moray", "maritime.submarine", "sea", 33.55, -41.3, {
      headingDeg: 240,
      speedKts: 6,
      supply: 92,
      taskForce: "4th Patrol Flotilla",
      sensors: [sensor("sonar", 35), sensor("esm", 50)],
      weapons: [weapon("torpedo", 25, 0.65, 8)],
      notes: "Patrol line across the expected convoy track.",
    }),
    unit("red-sg-pgm-01", "red", "P-317 Mamba", "maritime.missile-boat", "sea", 33.82, -40.4, {
      headingDeg: 220,
      speedKts: 26,
      supply: 78,
      taskForce: "4th Patrol Flotilla",
      sensors: [sensor("surface-search-radar", 70), sensor("esm", 90)],
      weapons: [weapon("ssm", 90, 0.5, 4), weapon("gun", 15, 0.25, 12)],
    }),
    unit("red-sg-pgm-02", "red", "P-319 Taipan", "maritime.missile-boat", "sea", 33.48, -40.2, {
      headingDeg: 220,
      speedKts: 26,
      supply: 78,
      taskForce: "4th Patrol Flotilla",
      sensors: [sensor("surface-search-radar", 70), sensor("esm", 90)],
      weapons: [weapon("ssm", 90, 0.5, 4), weapon("gun", 15, 0.25, 12)],
    }),
    unit("red-sg-fs-01", "red", "31st Strike Squadron", "air.fighter-squadron", "air", 33.35, -39.9, {
      headingDeg: 250,
      speedKts: 100,
      supply: 82,
      taskForce: "72nd Air Regiment",
      sensors: [sensor("air-search-radar", 110)],
      weapons: [weapon("strike", 130, 0.5, 12), weapon("aam", 60, 0.45, 8)],
      notes: "Anti-shipping strike alert over Vela do Sul.",
    }),
    unit("red-sg-rdr-01", "red", "Vela do Sul Surveillance Site", "facility.radar-site", "land", 33.31, -39.86, {
      headingDeg: 0,
      supply: 88,
      taskForce: "IADS Meridian",
      sensors: [sensor("air-search-radar", 200), sensor("surface-search-radar", 140)],
      weapons: [],
    }),
  ];
}

function straitGuardianObjectives() {
  const merchants = ["blu-sg-mer-01", "blu-sg-mer-02", "blu-sg-mer-03"];
  return [
    {
      id: "obj-sg-deliver",
      side: "blue",
      title: "Deliver convoy MERIDIAN-7",
      description: "Bring all three chartered merchants into the strait anchorage.",
      kind: "deliver",
      area: { center: wp(33.95, -40.35), radiusKm: 35 },
      targetUnitIds: merchants,
      weight: 0.6,
    },
    {
      id: "obj-sg-protect",
      side: "blue",
      title: "Protect the merchants",
      description: "No merchant hull lost to sub-surface or missile attack.",
      kind: "protect",
      targetUnitIds: merchants,
      weight: 0.4,
    },
    {
      id: "obj-sg-red-sink",
      side: "red",
      title: "Sink the sealift",
      description: "Destroy the chartered merchants before they reach the anchorage.",
      kind: "destroy",
      targetUnitIds: merchants,
      weight: 0.7,
    },
    {
      id: "obj-sg-red-deny",
      side: "red",
      title: "Deny the approach lane",
      description: "Hold the southwestern approach lane closed to coalition shipping.",
      kind: "deny",
      area: { center: wp(33.6, -41.2), radiusKm: 45 },
      weight: 0.3,
    },
  ];
}

export function buildScenarios() {
  const blueSide = (commander) => ({
    id: "blue",
    name: "BLUE · Coalition Task Force",
    commander,
    color: "#1f5f99",
  });
  const redSide = (commander) => ({
    id: "red",
    name: "RED · Opposing Force (OPFOR)",
    commander,
    color: "#b42318",
  });

  return [
    {
      id: "scn-azure-horizon",
      name: "AZURE HORIZON · Meridian Strait Seizure",
      codename: "AZURE HORIZON",
      description:
        "Coalition carrier strike group and amphibious ready group approach the Meridian Archipelago from the west to open the strait, dismantle the RED integrated air defense and land a marine battalion, against a layered OPFOR coastal and air defense.",
      theater: "Meridian Archipelago",
      mapCenter: wp(34.0, -40.9),
      mapZoom: 7,
      durationHours: 72,
      status: "ready",
      createdBy: "Plans Cell (J5)",
      updatedAt: "2026-08-15T09:40:00Z",
      sides: [blueSide("RADM Elin Castellane"), redSide("MG Viktor Draken")],
      units: [...azureBlueUnits(), ...azureRedUnits()],
      objectives: azureObjectives(),
      environment: {
        weather: "overcast",
        seaState: 3,
        visibilityKm: 16,
        emcon: "restricted",
        cyberThreat: "elevated",
      },
    },
    {
      id: "scn-strait-guardian",
      name: "STRAIT GUARDIAN · Convoy Escort",
      codename: "STRAIT GUARDIAN",
      description:
        "A three-ship sealift convoy with destroyer and frigate escort runs the southwestern approach lane to the Meridian Strait against submarine, missile-boat and air threats.",
      theater: "Meridian Archipelago",
      mapCenter: wp(33.6, -41.2),
      mapZoom: 7,
      durationHours: 48,
      status: "draft",
      createdBy: "Plans Cell (J5)",
      updatedAt: "2026-08-16T11:05:00Z",
      sides: [blueSide("CDRE Ada Reyes"), redSide("COL Stefan Marek")],
      units: straitGuardianUnits(),
      objectives: straitGuardianObjectives(),
      environment: {
        weather: "clear",
        seaState: 2,
        visibilityKm: 24,
        emcon: "restricted",
        cyberThreat: "low",
      },
    },
    {
      id: "scn-blank-template",
      name: "Blank planning template",
      codename: "TEMPLATE",
      description:
        "Empty Meridian Archipelago canvas: sides and environment pre-configured, no units or objectives. Duplicate this scenario to start a new design.",
      theater: "Meridian Archipelago",
      mapCenter: wp(34.0, -40.5),
      mapZoom: 7,
      durationHours: 48,
      status: "draft",
      createdBy: "Platform Admin",
      updatedAt: "2026-08-12T08:00:00Z",
      sides: [blueSide("TBD"), redSide("TBD")],
      units: [],
      objectives: [],
      environment: {
        weather: "clear",
        seaState: 2,
        visibilityKm: 20,
        emcon: "free",
        cyberThreat: "low",
      },
    },
  ];
}

// --------------------------------------------------------------------------
// Rule sets
// --------------------------------------------------------------------------

export function buildRuleSets() {
  return [
    {
      id: "rs-standard",
      name: "Standard Engagement Rules v2.1",
      description:
        "Baseline joint adjudication: probabilistic detection with EMCON and weather modifiers, pk-based engagements, supply-coupled movement and endgame victory scoring.",
      domainFocus: "joint",
      status: "active",
      rules: [
        rule(
          "rul-std-01",
          "EMCON silent discipline",
          "detection",
          "Force-wide emissions silence sharply reduces the chance of being detected.",
          [cond("emcon", "eq", "silent")],
          [fx("modify-detection", { factor: 0.55 })],
          10
        ),
        rule(
          "rul-std-02",
          "Storm clutter",
          "detection",
          "Storm conditions degrade radar and visual detection across the theater.",
          [cond("weather", "eq", "storm")],
          [fx("modify-detection", { factor: 0.7 })],
          12
        ),
        rule(
          "rul-std-03",
          "Visual horizon reveal",
          "detection",
          "Any unit closing inside 22 km of an opponent is revealed regardless of emissions posture.",
          [cond("range", "within-km", 22)],
          [fx("reveal-unit", {})],
          14
        ),
        rule(
          "rul-std-04",
          "Sea-skimmer masking",
          "detection",
          "High sea states mask low-signature surface contacts in clutter.",
          [cond("seaState", "gte", 5)],
          [fx("modify-detection", { factor: 0.85 })],
          16
        ),
        rule(
          "rul-std-05",
          "Littoral ASM bonus",
          "engagement",
          "Anti-ship fires inside 45 km benefit from reduced reaction time against sea targets.",
          [cond("range", "within-km", 45), cond("target.domain", "eq", "sea")],
          [fx("modify-pk", { factor: 1.15 })],
          20
        ),
        rule(
          "rul-std-06",
          "Heavy seas gunnery penalty",
          "engagement",
          "Sea state 5 or above degrades fire-control solutions.",
          [cond("seaState", "gte", 5)],
          [fx("modify-pk", { factor: 0.8 })],
          22
        ),
        rule(
          "rul-std-07",
          "Low magazine discipline",
          "engagement",
          "Units below 30% supply conserve rounds and accept degraded engagement quality.",
          [cond("actor.supply", "lt", 30)],
          [fx("modify-pk", { factor: 0.7 })],
          24
        ),
        rule(
          "rul-std-08",
          "Storm transit penalty",
          "movement",
          "Storm conditions slow surface transit and flight operations.",
          [cond("weather", "eq", "storm")],
          [fx("modify-speed", { factor: 0.75 })],
          30
        ),
        rule(
          "rul-std-09",
          "Damaged propulsion",
          "movement",
          "Units below half strength lose propulsion and maneuver performance.",
          [cond("actor.strength", "lt", 50)],
          [fx("modify-speed", { factor: 0.6 })],
          32
        ),
        rule(
          "rul-std-10",
          "Heavy weather consumption",
          "logistics",
          "Sea state 6+ increases fuel burn across the force.",
          [cond("seaState", "gte", 6)],
          [fx("consume-supply", { amount: 0.6 })],
          40
        ),
        rule(
          "rul-std-11",
          "Critical supply flash",
          "logistics",
          "Units below 15% supply raise a critical sustainment report.",
          [cond("actor.supply", "lt", 15)],
          [fx("spawn-event", { title: "Critical supply state", severity: "warn" })],
          42
        ),
        rule(
          "rul-std-12",
          "Progressive hull degradation",
          "attrition",
          "Sea units below 20% strength take progressive flooding damage each cycle.",
          [cond("actor.strength", "lt", 20), cond("actor.domain", "eq", "sea")],
          [fx("apply-damage", { amount: 1.5 })],
          50
        ),
        rule(
          "rul-std-13",
          "High-value kill bonus",
          "victory",
          "Confirmed destruction of a RED unit scores victory points for BLUE.",
          [cond("target.side", "eq", "red"), cond("target.status", "eq", "destroyed")],
          [fx("score-points", { points: 6 })],
          60
        ),
        rule(
          "rul-std-14",
          "Endgame emphasis",
          "victory",
          "Objectives held during the final 12 hours weigh more heavily in the outcome.",
          [cond("simTimeH", "gte", 60)],
          [fx("score-points", { points: 2 })],
          62
        ),
      ],
      adjudication: {
        mode: "hybrid",
        dieModel: "stochastic",
        seed: 20260810,
        phaseOrder: ["movement", "detection", "engagement", "logistics", "attrition", "victory"],
      },
      updatedAt: "2026-08-14T10:15:00Z",
      author: "Simulation Control",
    },
    {
      id: "rs-high-intensity",
      name: "High-Intensity Attrition Study",
      description:
        "Deterministic stress model for attrition analysis: dense salvos, accelerated damage accumulation, wartime consumption rates and forced commander decision checks.",
      domainFocus: "sea",
      status: "draft",
      rules: [
        rule(
          "rul-hi-01",
          "Salvo density",
          "engagement",
          "Close-range salvos are massed for effect, raising hit probability.",
          [cond("range", "within-km", 60)],
          [fx("modify-pk", { factor: 1.3 })],
          10
        ),
        rule(
          "rul-hi-02",
          "No reattack restraint",
          "engagement",
          "Damaged targets are re-engaged immediately without battle-damage assessment pauses.",
          [cond("target.strength", "lt", 60)],
          [fx("modify-pk", { factor: 1.15 })],
          12
        ),
        rule(
          "rul-hi-03",
          "Full-spectrum sensing",
          "detection",
          "Study assumption: both sides operate with unrestricted sensor postures.",
          [cond("simTimeH", "gte", 0)],
          [fx("modify-detection", { factor: 1.25 })],
          20
        ),
        rule(
          "rul-hi-04",
          "Flank speed doctrine",
          "movement",
          "Well-supplied units run at flank speed throughout the study window.",
          [cond("actor.supply", "gte", 40)],
          [fx("modify-speed", { factor: 1.1 })],
          30
        ),
        rule(
          "rul-hi-05",
          "Wartime burn rate",
          "logistics",
          "All units consume fuel and munitions at accelerated wartime rates.",
          [cond("simTimeH", "gte", 0)],
          [fx("consume-supply", { amount: 0.8 })],
          40
        ),
        rule(
          "rul-hi-06",
          "Accelerated attrition",
          "attrition",
          "Units below 40% strength accumulate systems failures every cycle.",
          [cond("actor.strength", "lt", 40)],
          [fx("apply-damage", { amount: 3 })],
          50
        ),
        rule(
          "rul-hi-07",
          "Commander commit check",
          "engagement",
          "When a formation drops below 60% strength the commander must decide whether to commit reserves.",
          [cond("actor.strength", "lt", 60)],
          [fx("request-decision", { title: "Commit the reserve?" })],
          54
        ),
        rule(
          "rul-hi-08",
          "Decisive destruction",
          "victory",
          "Every confirmed RED kill scores heavily toward the study endpoint.",
          [cond("target.side", "eq", "red"), cond("target.status", "eq", "destroyed")],
          [fx("score-points", { points: 10 })],
          60
        ),
      ],
      adjudication: {
        mode: "auto",
        dieModel: "deterministic",
        seed: 7,
        phaseOrder: ["movement", "detection", "engagement", "logistics", "attrition", "victory"],
      },
      updatedAt: "2026-08-16T15:30:00Z",
      author: "Analysis Cell (J8)",
    },
  ];
}

// --------------------------------------------------------------------------
// Agent library
// --------------------------------------------------------------------------

export function buildAgents() {
  const agent = (id, name, driveMode, specialty, description, version, status, winRate, avgLatencyMs, trainingEpisodes, lastEvaluated) => ({
    id,
    name,
    driveMode,
    specialty,
    description,
    version,
    status,
    metrics: { winRate, avgLatencyMs, trainingEpisodes, lastEvaluated },
  });

  return [
    agent(
      "agt-fires-01",
      "HAMMERFALL Fires Coordinator",
      "data-learning",
      "fire-strike",
      "Reinforcement-trained fires agent sequencing missile salvos and gunnery against maritime and land targets.",
      "3.4.1",
      "ready",
      0.74,
      120,
      1850000,
      "2026-08-12T09:00:00Z"
    ),
    agent(
      "agt-route-01",
      "PATHFINDER Route Optimizer",
      "operations-research",
      "route-planning",
      "Mixed-integer routing model producing threat-weighted transit tracks through the archipelago.",
      "5.1.0",
      "ready",
      0.81,
      45,
      240000,
      "2026-08-14T14:30:00Z"
    ),
    agent(
      "agt-log-01",
      "QUARTERMASTER Sustainment Planner",
      "operations-research",
      "logistics",
      "Inventory-flow optimizer scheduling underway replenishment and predicting supply exhaustion.",
      "4.0.2",
      "ready",
      0.77,
      60,
      310000,
      "2026-08-13T11:20:00Z"
    ),
    agent(
      "agt-situ-01",
      "ORACLE Situation Synthesizer",
      "large-model",
      "situation-understanding",
      "Large-model analyst fusing the observation API stream into commander-readable situation estimates.",
      "2.3.0",
      "ready",
      0.69,
      850,
      52000,
      "2026-08-15T08:45:00Z"
    ),
    agent(
      "agt-air-01",
      "SKYWEAVE Air Tasking Agent",
      "data-learning",
      "air-tasking",
      "Learned air-tasking policy cycling CAP stations, tanking and alert postures across the air plan.",
      "3.1.5",
      "ready",
      0.72,
      140,
      1420000,
      "2026-08-12T16:10:00Z"
    ),
    agent(
      "agt-asw-01",
      "TRIDENT NET ASW Screen Manager",
      "knowledge-reasoning",
      "asw-screen",
      "Doctrine behavior trees positioning the ASW screen and prosecuting sub-surface contacts.",
      "6.2.1",
      "ready",
      0.78,
      35,
      98000,
      "2026-08-11T10:05:00Z"
    ),
    agent(
      "agt-ew-01",
      "STATIC VEIL EW Planner",
      "knowledge-reasoning",
      "ew-planning",
      "Rule-based electromagnetic maneuver planner managing EMCON postures and jamming windows.",
      "2.8.0",
      "ready",
      0.7,
      55,
      76000,
      "2026-08-10T13:40:00Z"
    ),
    agent(
      "agt-strike-01",
      "LONGBOW Strike Package Builder",
      "hybrid",
      "strike-package",
      "Hybrid planner composing strike packages: target sets, standoff geometry, escorts and timing.",
      "1.9.3",
      "ready",
      0.75,
      320,
      640000,
      "2026-08-14T09:25:00Z"
    ),
    agent(
      "agt-sead-01",
      "VIPERTOOTH SEAD Sequencer",
      "hybrid",
      "sead",
      "Hybrid suppression agent ordering emitter kills to open air corridors through the IADS.",
      "2.2.0",
      "ready",
      0.71,
      280,
      580000,
      "2026-08-13T17:55:00Z"
    ),
    agent(
      "agt-amphib-01",
      "SHOREBREAK Amphibious Timer",
      "operations-research",
      "amphib-timing",
      "Schedule optimizer sequencing the ship-to-shore movement against tide, threat and fires windows.",
      "3.0.1",
      "ready",
      0.68,
      70,
      120000,
      "2026-08-12T12:00:00Z"
    ),
    agent(
      "agt-cyber-01",
      "NIGHTGLASS Cyber Effects Agent",
      "hybrid",
      "cyber-effects",
      "Hybrid cyber agent pairing exploit selection with kinetic timing; currently in supervised training.",
      "0.9.7",
      "training",
      0.61,
      190,
      210000,
      "2026-08-16T07:30:00Z"
    ),
    agent(
      "agt-coa-01",
      "WARGAMER COA Synthesizer",
      "large-model",
      "coa-synthesis",
      "Large-model planner generating doctrinally distinct courses of action with phased tasking and scores.",
      "2.5.2",
      "ready",
      0.73,
      1200,
      48000,
      "2026-08-15T18:00:00Z"
    ),
  ];
}

// --------------------------------------------------------------------------
// Missions
// --------------------------------------------------------------------------

export function buildMissions() {
  const st = (id, title, domain, description, startH, endH, assignedAgentId, assignedUnitIds, dependsOn) => ({
    id,
    title,
    domain,
    description,
    startH,
    endH,
    assignedAgentId,
    assignedUnitIds,
    dependsOn,
    status: "assigned",
  });

  return [
    {
      id: "msn-az-01",
      scenarioId: "scn-azure-horizon",
      side: "blue",
      title: "Open and secure the Meridian Strait",
      intent:
        "Approach from the west under restricted emissions, dismantle the RED integrated air defense and coastal missile threat, open the strait to coalition shipping and put the marine battalion ashore on Monte Meridian. Preserve the carrier above all.",
      endState:
        "Strait open under coalition sea control, RED IADS combat-ineffective, 1st Bn / 5th Coalition Marines ashore with a sustainable beachhead, CVN 79 Vigilant combat-effective.",
      status: "decomposed",
      subTasks: [
        st(
          "st-az-01",
          "Establish the ISR picture",
          "air",
          "Push UAV and AEW&C orbits east to map the RED surface picture and emitter locations.",
          0,
          12,
          "agt-situ-01",
          ["blu-uav-01", "blu-aew-01"],
          []
        ),
        st(
          "st-az-02",
          "Sanitize the submarine threat axis",
          "sea",
          "Sweep the strait approach with the SSN, maritime patrol and the trailing frigate to fix S-201.",
          4,
          20,
          "agt-asw-01",
          ["blu-ssn-01", "blu-mpa-01", "blu-ffg-02"],
          ["st-az-01"]
        ),
        st(
          "st-az-03",
          "Degrade RED C2 and sensor networks",
          "cyber",
          "Deliver cyber effects against the joint command post and early-warning network before the SEAD push.",
          6,
          24,
          "agt-cyber-01",
          ["blu-cyb-01"],
          ["st-az-01"]
        ),
        st(
          "st-az-04",
          "Suppress the RED IADS",
          "air",
          "SEAD sweeps against the 401st and 402nd SAM battalions and their cueing radars.",
          12,
          30,
          "agt-sead-01",
          ["blu-vsq-01", "blu-vfa-01"],
          ["st-az-01", "st-az-03"]
        ),
        st(
          "st-az-05",
          "Strike the coastal missile batteries",
          "air",
          "Standoff strikes against both coastal defense batteries covering the strait.",
          18,
          36,
          "agt-strike-01",
          ["blu-vsq-01", "blu-ddg-01"],
          ["st-az-04"]
        ),
        st(
          "st-az-06",
          "Clear RED surface combatants",
          "sea",
          "Destroy or drive off the missile boats and corvettes holding the strait picket line.",
          24,
          44,
          "agt-fires-01",
          ["blu-ddg-01", "blu-ddg-02", "blu-ffg-01"],
          ["st-az-02", "st-az-04"]
        ),
        st(
          "st-az-07",
          "Escort the amphibious approach",
          "sea",
          "Route and screen the amphibious group through the cleared strait to the objective area.",
          40,
          56,
          "agt-route-01",
          ["blu-lha-01", "blu-ffg-02", "blu-ddg-02"],
          ["st-az-05", "st-az-06"]
        ),
        st(
          "st-az-08",
          "Land the marine battalion",
          "land",
          "Execute the ship-to-shore movement and establish the beachhead on Monte Meridian.",
          52,
          62,
          "agt-amphib-01",
          ["blu-mar-01", "blu-lha-01"],
          ["st-az-07"]
        ),
        st(
          "st-az-09",
          "Sustain and screen the force",
          "sea",
          "Cycle underway replenishment and keep the main body supplied throughout the operation.",
          12,
          72,
          "agt-log-01",
          ["blu-aor-01"],
          ["st-az-01"]
        ),
        st(
          "st-az-10",
          "Consolidate and screen the beachhead",
          "land",
          "Hold CAP over the beachhead and consolidate the battalion's lodgment.",
          60,
          72,
          "agt-air-01",
          ["blu-vfa-02", "blu-mar-01"],
          ["st-az-08"]
        ),
      ],
      updatedAt: "2026-08-13T14:55:00Z",
    },
    {
      id: "msn-sg-01",
      scenarioId: "scn-strait-guardian",
      side: "blue",
      title: "Escort convoy MERIDIAN-7",
      intent:
        "Screen the three-ship sealift convoy along the southwestern approach lane, defeat sub-surface and missile-boat attacks, and deliver all hulls to the strait anchorage.",
      endState: "All three merchants alongside at the anchorage, escorts combat-effective, approach lane established as a recurring route.",
      status: "draft",
      subTasks: [],
      updatedAt: "2026-08-16T11:10:00Z",
    },
  ];
}

// --------------------------------------------------------------------------
// COAs, three pre-generated candidates for msn-az-01
// --------------------------------------------------------------------------

export function buildCoas() {
  const asg = (subTaskId, unitIds, action, waypoints) => ({ subTaskId, unitIds, action, waypoints });
  const phase = (id, name, startH, endH, intent, assignments) => ({ id, name, startH, endH, intent, assignments });

  return [
    {
      id: "coa-az-01",
      scenarioId: "scn-azure-horizon",
      missionId: "msn-az-01",
      name: "Direct Thrust",
      approach: "Tempo over attrition, force the strait early behind minimum-necessary suppression",
      summary:
        "The task force closes the strait at best speed behind an aggressive ASW and ISR screen, suppresses only the IADS nodes covering the transit corridor, runs the strait by H+36 and lands the battalion on the western beach by H+62. Fastest route to the end state; accepts exposure to the coastal missile arc during the transit.",
      generatedBy: "agent",
      generatorAgentId: "agt-coa-01",
      phases: [
        phase("coa-az-01-p1", "Advance to contact", 0, 16, "Close the strait approaches at best speed behind the ASW and ISR screen.", [
          asg("st-az-01", ["blu-uav-01", "blu-aew-01"], "push-isr-east", [wp(34.25, -41.9), wp(34.15, -41.3), wp(34.05, -40.9)]),
          asg("st-az-02", ["blu-ssn-01", "blu-mpa-01"], "asw-sweep-axis", [wp(34.0, -42.1), wp(33.95, -41.4), wp(33.9, -40.95)]),
          asg(
            "st-az-09",
            ["blu-cvn-01", "blu-ddg-01", "blu-ddg-02", "blu-ffg-01", "blu-aor-01"],
            "advance-axis-center",
            [wp(34.05, -42.6), wp(34.02, -42.0), wp(34.0, -41.55)]
          ),
          asg("st-az-03", ["blu-cyb-01"], "degrade-red-c2", [wp(34.05, -42.6)]),
        ]),
        phase("coa-az-01-p2", "Force the strait", 16, 36, "Suppress the corridor IADS nodes and run the strait under EW cover.", [
          asg("st-az-04", ["blu-vsq-01", "blu-vfa-01"], "sead-sweep", [wp(34.1, -41.2), wp(34.05, -40.6), wp(34.1, -40.1)]),
          asg("st-az-05", ["blu-ddg-01", "blu-vsq-01"], "strike-coastal-batteries", [wp(34.0, -41.0), wp(33.98, -40.55)]),
          asg("st-az-06", ["blu-ddg-02", "blu-ffg-01"], "clear-strait-surface", [wp(34.02, -41.3), wp(34.0, -40.5), wp(34.0, -40.2)]),
          asg("st-az-09", ["blu-cvn-01", "blu-aor-01"], "trail-main-body", [wp(34.02, -41.6), wp(34.0, -41.2)]),
        ]),
        phase("coa-az-01-p3", "Clear and escort", 36, 56, "Hold the strait open and bring the amphibious group through.", [
          asg("st-az-06", ["blu-ddg-01", "blu-ffg-01"], "patrol-strait", [wp(34.0, -40.3), wp(33.96, -40.12)]),
          asg(
            "st-az-07",
            ["blu-lha-01", "blu-ffg-02", "blu-ddg-02"],
            "escort-amphib-through-strait",
            [wp(34.1, -42.2), wp(34.02, -41.2), wp(34.0, -40.4), wp(34.0, -40.05)]
          ),
          asg("st-az-01", ["blu-uav-01", "blu-aew-01"], "overwatch-strait", [wp(34.1, -40.6)]),
        ]),
        phase("coa-az-01-p4", "Land and consolidate", 56, 72, "Put the battalion ashore on the western beach and consolidate strait control.", [
          asg("st-az-08", ["blu-lha-01", "blu-mar-01"], "land-west-beach", [wp(34.0, -40.05), wp(34.02, -39.95)]),
          asg("st-az-10", ["blu-mar-01", "blu-ffg-01"], "consolidate-beachhead", [wp(34.03, -39.92)]),
          asg("st-az-09", ["blu-aor-01"], "resupply-station", [wp(33.9, -40.45)]),
        ]),
      ],
      scores: { feasibility: 78, acceptability: 64, risk: 72, resourceCost: 58, expectedEffect: 74, composite: 71 },
      status: "selected",
      color: "#1f5f99",
      createdAt: "2026-08-13T15:10:00Z",
    },
    {
      id: "coa-az-02",
      scenarioId: "scn-azure-horizon",
      missionId: "msn-az-01",
      name: "Air-First Suppression",
      approach: "Standoff rollback, no hull enters the weapon engagement zone until the IADS is down",
      summary:
        "The main body holds west of the coastal missile arc while a 26-hour air and cyber campaign methodically rolls back the IADS and both coastal batteries. Only then does the force advance through the strait for a deliberate landing in the final phase. Lowest risk to capital ships; costs sorties, munitions and 20+ hours of tempo.",
      generatedBy: "agent",
      generatorAgentId: "agt-coa-01",
      phases: [
        phase("coa-az-02-p1", "Standoff ISR and EW", 0, 14, "Build the emitter map and open cyber effects while the force holds at standoff.", [
          asg("st-az-01", ["blu-uav-01", "blu-aew-01"], "isr-arc-standoff", [wp(34.35, -42.2), wp(34.3, -41.8)]),
          asg("st-az-03", ["blu-cyb-01"], "degrade-red-c2", [wp(34.05, -42.7)]),
          asg("st-az-02", ["blu-ssn-01", "blu-mpa-01"], "asw-barrier-west", [wp(33.95, -42.2), wp(33.9, -41.85)]),
          asg("st-az-09", ["blu-cvn-01", "blu-ddg-01", "blu-ddg-02", "blu-ffg-01"], "hold-and-screen", [wp(34.05, -42.7)]),
        ]),
        phase("coa-az-02-p2", "Air campaign", 14, 40, "Roll back the IADS from standoff before any hull enters the missile arc.", [
          asg("st-az-04", ["blu-vsq-01", "blu-vfa-01"], "sead-rollback-waves", [wp(34.3, -41.4), wp(34.2, -40.7), wp(34.2, -40.2)]),
          asg("st-az-05", ["blu-vsq-01", "blu-ddg-01"], "standoff-battery-strikes", [wp(33.85, -41.3), wp(33.9, -40.85)]),
          asg("st-az-09", ["blu-cvn-01", "blu-aor-01"], "edge-east-slowly", [wp(34.03, -42.3), wp(34.0, -42.0)]),
        ]),
        phase("coa-az-02-p3", "Advance through the strait", 40, 60, "Advance the main body through the suppressed corridor and clear residual pickets.", [
          asg("st-az-06", ["blu-ddg-01", "blu-ddg-02", "blu-ffg-01"], "clear-strait-surface", [wp(34.0, -41.2), wp(34.0, -40.4)]),
          asg("st-az-09", ["blu-cvn-01", "blu-aor-01"], "advance-axis-center", [wp(34.0, -41.6), wp(34.0, -41.1)]),
          asg("st-az-07", ["blu-lha-01", "blu-ffg-02"], "escort-amphib-through-strait", [wp(34.1, -42.0), wp(34.02, -40.9), wp(34.0, -40.3)]),
        ]),
        phase("coa-az-02-p4", "Deliberate landing", 60, 72, "Land against a suppressed defense and consolidate.", [
          asg("st-az-08", ["blu-lha-01", "blu-mar-01"], "land-west-beach", [wp(34.0, -40.05), wp(34.02, -39.95)]),
          asg("st-az-10", ["blu-mar-01", "blu-vfa-02"], "consolidate-beachhead", [wp(34.03, -39.92)]),
        ]),
      ],
      scores: { feasibility: 82, acceptability: 78, risk: 46, resourceCost: 72, expectedEffect: 68, composite: 74 },
      status: "candidate",
      color: "#7c3aed",
      createdAt: "2026-08-13T15:10:00Z",
    },
    {
      id: "coa-az-03",
      scenarioId: "scn-azure-horizon",
      missionId: "msn-az-01",
      name: "Envelop & Blockade",
      approach: "Indirect approach, swing north of Ilha Norte, blockade the east and strangle sustainment",
      summary:
        "The force feints west then swings north around Ilha Norte, rolls up the northern SAM coverage, and establishes a blockade east of Monte Meridian to cut the garrison off from resupply. Strikes reduce the depot and command post before a late landing on the northern beach. Avoids the strait gauntlet entirely; longest route, heaviest fuel bill, and the strait itself is only secured indirectly.",
      generatedBy: "agent",
      generatorAgentId: "agt-coa-01",
      phases: [
        phase("coa-az-03-p1", "Northern feint", 0, 16, "Feint at the strait while the force turns onto the northern axis.", [
          asg("st-az-01", ["blu-uav-01", "blu-aew-01"], "isr-north-axis", [wp(34.6, -41.9), wp(34.9, -41.2)]),
          asg("st-az-02", ["blu-ssn-01", "blu-mpa-01"], "asw-sweep-north", [wp(34.3, -42.0), wp(34.6, -41.4)]),
          asg("st-az-09", ["blu-cvn-01", "blu-ddg-01", "blu-ddg-02", "blu-ffg-01"], "advance-axis-north", [wp(34.3, -42.4), wp(34.6, -41.8)]),
          asg("st-az-03", ["blu-cyb-01"], "degrade-red-c2", [wp(34.3, -42.4)]),
        ]),
        phase("coa-az-03-p2", "Envelop north", 16, 40, "Round Ilha Norte, reduce the northern SAM node and sweep the northern picket.", [
          asg(
            "st-az-09",
            ["blu-cvn-01", "blu-ddg-01", "blu-aor-01"],
            "round-ilha-norte",
            [wp(34.9, -41.2), wp(35.25, -40.4), wp(35.15, -39.6)]
          ),
          asg("st-az-04", ["blu-vsq-01", "blu-vfa-01"], "sead-northern-sam", [wp(34.95, -40.6), wp(34.95, -40.2)]),
          asg("st-az-06", ["blu-ddg-02", "blu-ffg-01"], "sweep-northern-picket", [wp(34.7, -40.6), wp(34.55, -40.0)]),
        ]),
        phase("coa-az-03-p3", "Blockade and strangle", 40, 60, "Blockade east of Monte Meridian and cut the garrison's sustainment.", [
          asg("st-az-05", ["blu-vsq-01", "blu-vfa-01"], "strike-depot-and-c2", [wp(34.6, -39.0), wp(34.4, -38.9)]),
          asg("st-az-06", ["blu-ddg-01", "blu-ddg-02"], "blockade-east", [wp(34.5, -39.15), wp(34.28, -39.0)]),
          asg("st-az-07", ["blu-lha-01", "blu-ffg-02"], "stage-amphib-northeast", [wp(34.75, -41.0), wp(34.7, -39.9), wp(34.6, -39.55)]),
          asg("st-az-03", ["blu-cyb-01"], "isolate-red-c2", [wp(35.15, -39.6)]),
        ]),
        phase("coa-az-03-p4", "Reduce and land", 60, 72, "Land on the northern beach against a starved defense and consolidate.", [
          asg("st-az-08", ["blu-lha-01", "blu-mar-01"], "land-north-beach", [wp(34.5, -39.55), wp(34.43, -39.55)]),
          asg("st-az-10", ["blu-mar-01", "blu-vfa-02"], "consolidate-beachhead", [wp(34.4, -39.55)]),
          asg("st-az-09", ["blu-aor-01"], "resupply-station", [wp(34.7, -39.8)]),
        ]),
      ],
      scores: { feasibility: 66, acceptability: 70, risk: 55, resourceCost: 77, expectedEffect: 71, composite: 66 },
      status: "candidate",
      color: "#0d8a8a",
      createdAt: "2026-08-13T15:10:00Z",
    },
  ];
}

// --------------------------------------------------------------------------
// Platform, users, audit
// --------------------------------------------------------------------------

export function buildPlatform() {
  const ontology = buildOntology();
  const pieceCount = ontology.classes.filter((c) => c.category === "force").length;
  const ruleCount = buildRuleSets().reduce((n, rs) => n + rs.rules.length, 0);

  return {
    engines: [
      {
        id: "eng-horizon-rt",
        name: "HORIZON-RT",
        kind: "realtime",
        status: "online",
        loadPct: 22,
        activeRuns: 0,
        capabilities: ["multi-branch", "live-events", "umpire-intervention", "replay-capture"],
        version: "5.2.0",
      },
      {
        id: "eng-ledger-tb",
        name: "LEDGER-TB",
        kind: "turn-based",
        status: "online",
        loadPct: 8,
        activeRuns: 0,
        capabilities: ["igo-ugo", "deterministic-adjudication", "step-control", "branch-compare"],
        version: "3.7.4",
      },
      {
        id: "eng-kraken-cgf",
        name: "KRAKEN CGF",
        kind: "cgf",
        status: "online",
        loadPct: 31,
        activeRuns: 0,
        capabilities: ["behavior-trees", "formation-keeping", "sensor-fusion", "doctrine-templates"],
        version: "2.9.1",
      },
      {
        id: "eng-minerva-ai",
        name: "MINERVA AI Runtime",
        kind: "ai-runtime",
        status: "online",
        loadPct: 44,
        activeRuns: 0,
        capabilities: ["agent-hosting", "observation-api", "piece-drive-api", "policy-eval"],
        version: "1.6.0",
      },
    ],
    dataDomains: [
      {
        id: "dd-base",
        name: "Base data",
        store: "graph",
        records: 184203,
        sizeGB: 3.2,
        health: "healthy",
        description: "Ontology, piece library, map layers and platform vocabulary over the knowledge graph.",
      },
      {
        id: "dd-runtime",
        name: "Runtime data",
        store: "timeseries",
        records: 5412880,
        sizeGB: 18.6,
        health: "healthy",
        description: "Per-tick unit states, sensor tracks and engine telemetry from live and historical runs.",
      },
      {
        id: "dd-scenario",
        name: "Scenario data",
        store: "document",
        records: 3120,
        sizeGB: 0.9,
        health: "healthy",
        description: "Scenario documents: ORBATs, objectives, environments, validation reports and versions.",
      },
      {
        id: "dd-deduction",
        name: "Deduction process",
        store: "object",
        records: 964002,
        sizeGB: 24.4,
        health: "syncing",
        description: "Branch event logs, decision records, interventions and replay snapshot archives.",
      },
      {
        id: "dd-assessment",
        name: "Assessment data",
        store: "relational",
        records: 51240,
        sizeGB: 1.7,
        health: "healthy",
        description: "Scored assessments, dimension breakdowns, loss-exchange tables and cross-run comparisons.",
      },
    ],
    lowCode: { maps: 6, pieces: pieceCount, rules: ruleCount, scenarios: 3 },
    apiStats: { observationCalls: 48210, pieceDriveCalls: 17434, avgLatencyMs: 42 },
  };
}

export function buildUsers() {
  return [
    {
      id: "usr-cdr-01",
      name: "RADM Elin Castellane",
      role: "Joint Force Commander",
      org: "Exercise AZURE HORIZON",
      lastActive: "2026-08-17T15:12:00Z",
      permissions: ["dashboard", "deduction", "assessment", "ailayer"],
      status: "active",
    },
    {
      id: "usr-pln-01",
      name: "CDR Malik Osei",
      role: "Scenario & COA planner (J5)",
      org: "Exercise AZURE HORIZON",
      lastActive: "2026-08-17T13:40:00Z",
      permissions: ["dashboard", "scenario", "coa", "rules"],
      status: "active",
    },
    {
      id: "usr-ops-01",
      name: "LCDR Sana Verhoeven",
      role: "Exercise control / umpire",
      org: "Wargame Center",
      lastActive: "2026-08-17T16:02:00Z",
      permissions: ["dashboard", "deduction", "rules", "foundation"],
      status: "active",
    },
    {
      id: "usr-anl-01",
      name: "Dr. Ines Marchetti",
      role: "Assessment analyst (J8)",
      org: "Wargame Center",
      lastActive: "2026-08-16T18:25:00Z",
      permissions: ["dashboard", "assessment", "ailayer", "foundation"],
      status: "active",
    },
    {
      id: "usr-adm-01",
      name: "Petra Lindqvist",
      role: "Platform governance",
      org: "Wargame Center",
      lastActive: "2026-08-15T09:10:00Z",
      permissions: ["dashboard", "scenario", "coa", "rules", "deduction", "assessment", "ailayer", "foundation", "admin"],
      status: "active",
    },
  ];
}

export function buildAuditSeed() {
  const entry = (id, at, user, action, target, detail) => ({ id, at, user, action, target, detail });
  return [
    entry(
      "aud-seed-01",
      "2026-08-10T08:05:00Z",
      "Petra Lindqvist",
      "user.provision",
      "usr-cdr-01",
      "Provisioned commander workspace and decision-authority permissions for Exercise AZURE HORIZON."
    ),
    entry(
      "aud-seed-02",
      "2026-08-11T14:20:00Z",
      "Petra Lindqvist",
      "ontology.publish",
      "ontology@2.4.1",
      "Published ontology 2.4.1: added space branch and cyber effects attributes."
    ),
    entry(
      "aud-seed-03",
      "2026-08-12T08:00:00Z",
      "Petra Lindqvist",
      "scenario.create",
      "scn-blank-template",
      "Created the blank planning template for new scenario designs."
    ),
    entry(
      "aud-seed-04",
      "2026-08-12T10:30:00Z",
      "CDR Malik Osei",
      "scenario.create",
      "scn-azure-horizon",
      "Created AZURE HORIZON from the theater template with initial BLUE and RED ORBATs."
    ),
    entry(
      "aud-seed-05",
      "2026-08-13T14:55:00Z",
      "CDR Malik Osei",
      "mission.decompose",
      "msn-az-01",
      "Decomposed the strait-opening mission into 10 sub-tasks with agent assignments."
    ),
    entry(
      "aud-seed-06",
      "2026-08-13T15:10:00Z",
      "CDR Malik Osei",
      "coa.generate",
      "msn-az-01",
      "Generated 3 COA candidates via WARGAMER COA Synthesizer (Direct Thrust, Air-First Suppression, Envelop & Blockade)."
    ),
    entry(
      "aud-seed-07",
      "2026-08-14T10:15:00Z",
      "LCDR Sana Verhoeven",
      "ruleset.publish",
      "rs-standard",
      "Published Standard Engagement Rules v2.1 as the active joint adjudication baseline."
    ),
    entry(
      "aud-seed-08",
      "2026-08-14T16:45:00Z",
      "RADM Elin Castellane",
      "coa.select",
      "coa-az-01",
      "Selected Direct Thrust: tempo prioritized over standoff attrition; risk accepted at the strait transit."
    ),
    entry(
      "aud-seed-09",
      "2026-08-15T09:40:00Z",
      "CDR Malik Osei",
      "scenario.validate",
      "scn-azure-horizon",
      "Validation passed: ORBAT, objectives and environment checks green; scenario promoted to ready."
    ),
    entry(
      "aud-seed-10",
      "2026-08-15T18:00:00Z",
      "Dr. Ines Marchetti",
      "agent.evaluate",
      "agt-coa-01",
      "Re-evaluated WARGAMER on the benchmark suite: win rate 0.73 across 48k planning episodes."
    ),
    entry(
      "aud-seed-11",
      "2026-08-16T11:05:00Z",
      "CDR Malik Osei",
      "scenario.update",
      "scn-strait-guardian",
      "Drafted STRAIT GUARDIAN convoy-escort scenario for the follow-on exercise week."
    ),
    entry(
      "aud-seed-12",
      "2026-08-16T15:30:00Z",
      "Dr. Ines Marchetti",
      "ruleset.draft",
      "rs-high-intensity",
      "Drafted the High-Intensity Attrition Study rule set with deterministic adjudication for sensitivity analysis."
    ),
  ];
}
