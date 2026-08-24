// SANDTABLE unified data foundation, simulation ontology.
// Single-rooted class hierarchy: entity -> force-unit -> maritime/air/land/cyber/space
// branches, plus facility / system / event / concept subtrees. Shapes mirror
// `Ontology`, `OntologyClass`, `OntologyAttribute`, `OntologyRelation` in src/types.ts.

/** Build an OntologyAttribute. `extra` may carry unit, enumValues, description. */
function attr(name, type, extra = {}) {
  return { name, type, ...extra };
}

/** Build an OntologyClass. `extra` may carry domain and icon. */
function cls(id, label, parent, category, description, attributes, extra = {}) {
  return { id, label, parent, category, description, attributes, ...extra };
}

function rel(id, label, from, to, description) {
  return { id, label, from, to, description };
}

const PCT = { unit: "%" };
const KTS = { unit: "kts" };
const KM = { unit: "km" };
const DEG = { unit: "deg" };

export function buildOntology() {
  const classes = [
    // ------------------------------------------------------------------ root
    cls(
      "entity",
      "Entity",
      null,
      "concept",
      "Abstract root of everything the simulation can reason about: forces, facilities, systems, events and planning concepts.",
      [
        attr("name", "string", { description: "Human-readable designation." }),
        attr("side", "enum", { enumValues: ["blue", "red", "neutral"], description: "Owning side." }),
        attr("position", "latlng", { description: "Geographic anchor in the theater." }),
        attr("classification", "string", { description: "Exercise handling caveat, always fictional." }),
      ],
      { icon: "Box" }
    ),

    // ----------------------------------------------------------- force units
    cls(
      "force-unit",
      "Force unit",
      "entity",
      "force",
      "A maneuverable or emplaced combat element with strength, supply and a movement state. Base class for every piece on the sand table.",
      [
        attr("strength", "number", { ...PCT, description: "Combat effectiveness remaining, 0-100." }),
        attr("supply", "number", { ...PCT, description: "Fuel and munitions state, 0-100." }),
        attr("speedKts", "number", { ...KTS, description: "Current ordered speed." }),
        attr("headingDeg", "number", { ...DEG, description: "Course over ground." }),
        attr("status", "enum", {
          enumValues: ["active", "damaged", "destroyed", "withdrawn"],
          description: "Adjudicated unit state.",
        }),
      ],
      { icon: "Shield" }
    ),

    cls(
      "maritime.unit",
      "Maritime unit",
      "force-unit",
      "force",
      "Surface or sub-surface naval combatant or auxiliary operating in the sea domain.",
      [
        attr("displacementT", "number", { unit: "t", description: "Full-load displacement." }),
        attr("draftM", "number", { unit: "m", description: "Navigational draft; constrains shoal transit." }),
        attr("crew", "number", { unit: "persons", description: "Complement embarked." }),
        attr("seaKeepingLimit", "number", { unit: "sea state", description: "Highest sea state for unrestricted ops." }),
      ],
      { domain: "sea", icon: "Ship" }
    ),
    cls(
      "maritime.carrier",
      "Aircraft carrier",
      "maritime.unit",
      "force",
      "Fleet carrier providing the embarked air wing, strike coordination and task force flagship functions.",
      [
        attr("airWingSize", "number", { unit: "aircraft", description: "Embarked fixed-wing aircraft." }),
        attr("sortieRate", "number", { unit: "sorties/day", description: "Sustained daily sortie generation." }),
        attr("catapults", "number", { description: "Launch positions available." }),
        attr("deckSpots", "number", { description: "Simultaneous recovery/launch spots." }),
      ],
      { domain: "sea", icon: "Ship" }
    ),
    cls(
      "maritime.destroyer",
      "Guided-missile destroyer",
      "maritime.unit",
      "force",
      "Multi-mission escort optimized for area air defense and surface strike inside the task force screen.",
      [
        attr("vlsCells", "number", { description: "Vertical launch cells fitted." }),
        attr("aawRangeKm", "number", { ...KM, description: "Area air-defense engagement radius." }),
        attr("sonarSuite", "enum", { enumValues: ["hull", "towed", "hull+towed"], description: "ASW sensor fit." }),
        attr("helicopters", "number", { unit: "aircraft", description: "Embarked rotary-wing." }),
      ],
      { domain: "sea", icon: "Ship" }
    ),
    cls(
      "maritime.frigate",
      "Frigate",
      "maritime.unit",
      "force",
      "Escort combatant focused on anti-submarine screening and local air defense of the main body.",
      [
        attr("vlsCells", "number", { description: "Vertical launch cells fitted." }),
        attr("towedArray", "boolean", { description: "Towed sonar array fitted." }),
        attr("helicopters", "number", { unit: "aircraft", description: "Embarked rotary-wing." }),
      ],
      { domain: "sea", icon: "Ship" }
    ),
    cls(
      "maritime.submarine",
      "Submarine",
      "maritime.unit",
      "force",
      "Sub-surface combatant used for forward picketing, anti-surface ambush and covert surveillance.",
      [
        attr("propulsion", "enum", { enumValues: ["nuclear", "diesel-electric", "aip"], description: "Propulsion class." }),
        attr("submergedSpeedKts", "number", { ...KTS, description: "Maximum submerged speed." }),
        attr("testDepthM", "number", { unit: "m", description: "Certified diving depth." }),
        attr("torpedoTubes", "number", { description: "Torpedo tubes fitted." }),
      ],
      { domain: "sea", icon: "Waves" }
    ),
    cls(
      "maritime.amphibious",
      "Amphibious assault ship",
      "maritime.unit",
      "force",
      "Amphibious platform lifting the landing force with well deck and aviation facilities.",
      [
        attr("troopCapacity", "number", { unit: "persons", description: "Embarked landing force capacity." }),
        attr("landingCraft", "number", { description: "Surface connectors carried." }),
        attr("wellDeck", "boolean", { description: "Floodable well deck fitted." }),
        attr("aviationSpots", "number", { description: "Rotary-wing deck spots." }),
      ],
      { domain: "sea", icon: "Ship" }
    ),
    cls(
      "maritime.auxiliary",
      "Fleet auxiliary",
      "maritime.unit",
      "force",
      "Replenishment or sealift ship sustaining the force with fuel, munitions and dry cargo.",
      [
        attr("cargoFuelT", "number", { unit: "t", description: "Fuel cargo capacity." }),
        attr("cargoDryT", "number", { unit: "t", description: "Dry/munitions cargo capacity." }),
        attr("rasStations", "number", { description: "Underway replenishment stations." }),
      ],
      { domain: "sea", icon: "Container" }
    ),
    cls(
      "maritime.missile-boat",
      "Fast missile boat",
      "maritime.unit",
      "force",
      "Small, fast littoral combatant delivering anti-ship missile salvos from island cover.",
      [
        attr("missileCells", "number", { description: "Anti-ship missiles carried." }),
        attr("topSpeedKts", "number", { ...KTS, description: "Sprint speed." }),
        attr("signature", "enum", { enumValues: ["low", "medium", "high"], description: "Radar cross-section class." }),
      ],
      { domain: "sea", icon: "Zap" }
    ),
    cls(
      "maritime.corvette",
      "Corvette",
      "maritime.unit",
      "force",
      "Light surface combatant for littoral patrol, local air defense and anti-surface action.",
      [
        attr("missileCells", "number", { description: "Anti-ship missiles carried." }),
        attr("aswCapable", "boolean", { description: "Anti-submarine sensors and weapons fitted." }),
        attr("enduranceDays", "number", { unit: "days", description: "Unreplenished endurance." }),
      ],
      { domain: "sea", icon: "Ship" }
    ),

    cls(
      "air.unit",
      "Air unit",
      "force-unit",
      "force",
      "Squadron-level air element modeled as a station-keeping piece that patrols and surges along tasking waypoints.",
      [
        attr("aircraftCount", "number", { unit: "aircraft", description: "Airframes assigned." }),
        attr("combatRadiusKm", "number", { ...KM, description: "Mission radius with standard loadout." }),
        attr("stationTimeH", "number", { unit: "h", description: "Time on station per cycle." }),
        attr("basing", "enum", { enumValues: ["carrier", "airfield", "expeditionary"], description: "Operating base type." }),
      ],
      { domain: "air", icon: "Plane" }
    ),
    cls(
      "air.fighter-squadron",
      "Fighter squadron",
      "air.unit",
      "force",
      "Air-superiority squadron flying combat air patrol and escort stations.",
      [
        attr("aamLoadout", "number", { unit: "missiles", description: "Air-to-air missiles per sortie wave." }),
        attr("interceptSpeedKts", "number", { ...KTS, description: "Dash speed for intercepts." }),
        attr("nightCapable", "boolean", { description: "All-weather/night intercept rated." }),
      ],
      { domain: "air", icon: "Plane" }
    ),
    cls(
      "air.strike-squadron",
      "Strike squadron",
      "air.unit",
      "force",
      "Strike-fighter squadron delivering standoff weapons against maritime and land targets, including SEAD tasking.",
      [
        attr("standoffRangeKm", "number", { ...KM, description: "Release range of primary standoff weapon." }),
        attr("strikeLoadout", "number", { unit: "weapons", description: "Strike weapons per sortie wave." }),
        attr("seadCapable", "boolean", { description: "Anti-radiation suppression capable." }),
      ],
      { domain: "air", icon: "Rocket" }
    ),
    cls(
      "air.aew",
      "Airborne early warning",
      "air.unit",
      "force",
      "AEW&C orbit extending the force radar horizon and managing the air battle picture.",
      [
        attr("radarHorizonKm", "number", { ...KM, description: "Instrumented detection range." }),
        attr("tracksManaged", "number", { description: "Simultaneous tracks maintained." }),
        attr("linkCapacity", "number", { unit: "participants", description: "Datalink participants served." }),
      ],
      { domain: "air", icon: "Radar" }
    ),
    cls(
      "air.maritime-patrol",
      "Maritime patrol aircraft",
      "air.unit",
      "force",
      "Long-endurance patrol aircraft for wide-area surface search and anti-submarine prosecution.",
      [
        attr("sonobuoys", "number", { description: "Sonobuoys carried per sortie." }),
        attr("patrolEnduranceH", "number", { unit: "h", description: "On-station endurance." }),
        attr("magFitted", "boolean", { description: "Magnetic anomaly detector fitted." }),
      ],
      { domain: "air", icon: "Plane" }
    ),
    cls(
      "air.uav-recon",
      "Reconnaissance UAV",
      "air.unit",
      "force",
      "Unmanned long-dwell reconnaissance orbit feeding the observation API with persistent surveillance.",
      [
        attr("enduranceH", "number", { unit: "h", description: "Flight endurance." }),
        attr("sensorSuite", "enum", { enumValues: ["eo-ir", "radar", "multi-int"], description: "Primary payload." }),
        attr("datalinkRangeKm", "number", { ...KM, description: "Control/datalink range." }),
      ],
      { domain: "air", icon: "Eye" }
    ),

    cls(
      "land.unit",
      "Land unit",
      "force-unit",
      "force",
      "Ground formation, emplaced battery or garrison element operating in the land domain.",
      [
        attr("personnel", "number", { unit: "persons", description: "Assigned strength." }),
        attr("mobility", "enum", { enumValues: ["static", "foot", "wheeled", "tracked"], description: "Movement class." }),
        attr("entrenchment", "number", { ...PCT, description: "Fortification level, 0-100." }),
      ],
      { domain: "land", icon: "Shield" }
    ),
    cls(
      "land.marine-battalion",
      "Marine battalion",
      "land.unit",
      "force",
      "Amphibious infantry battalion, embarked for ship-to-shore assault and beachhead consolidation.",
      [
        attr("companies", "number", { description: "Maneuver companies." }),
        attr("amphibiousLift", "enum", { enumValues: ["surface", "air", "surface+air"], description: "Assault delivery mode." }),
        attr("organicFiresKm", "number", { ...KM, description: "Range of organic mortars/fires." }),
      ],
      { domain: "land", icon: "Users" }
    ),
    cls(
      "land.coastal-battery",
      "Coastal defense battery",
      "land.unit",
      "force",
      "Shore-based anti-ship missile battery covering strait approaches, cued by surveillance radars.",
      [
        attr("launchers", "number", { description: "Transporter-erector-launchers." }),
        attr("missilesPerLauncher", "number", { description: "Ready rounds per launcher." }),
        attr("reloadTimeMin", "number", { unit: "min", description: "Battery reload cycle." }),
      ],
      { domain: "land", icon: "Crosshair" }
    ),
    cls(
      "land.sam-battalion",
      "SAM battalion",
      "land.unit",
      "force",
      "Surface-to-air missile battalion forming a node of the integrated air defense system.",
      [
        attr("launchers", "number", { description: "Launch vehicles." }),
        attr("engagementAltitudeM", "number", { unit: "m", description: "Maximum engagement altitude." }),
        attr("simultaneousTargets", "number", { description: "Targets engaged concurrently." }),
        attr("emissionControl", "enum", { enumValues: ["active", "blinking", "passive"], description: "Radar emission posture." }),
      ],
      { domain: "land", icon: "Target" }
    ),
    cls(
      "land.artillery",
      "Artillery battalion",
      "land.unit",
      "force",
      "Tube and rocket artillery providing fires against beachheads and littoral shipping.",
      [
        attr("tubes", "number", { description: "Guns/launchers assigned." }),
        attr("maxRangeKm", "number", { ...KM, description: "Maximum firing range." }),
        attr("rateOfFire", "number", { unit: "rds/min", description: "Sustained rate of fire." }),
      ],
      { domain: "land", icon: "Crosshair" }
    ),

    cls(
      "cyber.unit",
      "Cyber unit",
      "force-unit",
      "force",
      "Cyber/electromagnetic activities element projecting non-kinetic effects across the theater.",
      [
        attr("operators", "number", { unit: "persons", description: "Mission operators." }),
        attr("accreditation", "enum", { enumValues: ["defensive", "offensive", "full-spectrum"], description: "Authorized mission set." }),
        attr("reachKm", "number", { ...KM, description: "Effective reach against networked targets." }),
      ],
      { domain: "cyber", icon: "Network" }
    ),
    cls(
      "cyber.ops-cell",
      "Cyber operations cell",
      "cyber.unit",
      "force",
      "Embarked cyber effects cell degrading adversary C2, sensors and logistics networks.",
      [
        attr("exploitCapacity", "number", { unit: "missions", description: "Concurrent effect missions." }),
        attr("attributionRisk", "number", { ...PCT, description: "Estimated attribution/exposure risk." }),
        attr("c2Degradation", "number", { ...PCT, description: "Expected command-network degradation per mission." }),
      ],
      { domain: "cyber", icon: "Network" }
    ),

    cls(
      "space.unit",
      "Space support element",
      "force-unit",
      "force",
      "Space-based support element providing surveillance and communications overwatch of the theater.",
      [
        attr("constellationSize", "number", { unit: "satellites", description: "Vehicles in the constellation." }),
        attr("orbitAltitudeKm", "number", { ...KM, description: "Nominal orbital altitude." }),
        attr("downlinkRateMbps", "number", { unit: "Mbps", description: "Theater downlink capacity." }),
      ],
      { domain: "space", icon: "Satellite" }
    ),
    cls(
      "space.recon-constellation",
      "Reconnaissance constellation",
      "space.unit",
      "force",
      "Imaging and ELINT constellation delivering periodic revisit over the archipelago.",
      [
        attr("revisitTimeMin", "number", { unit: "min", description: "Average revisit interval over the theater." }),
        attr("sensorMix", "enum", { enumValues: ["eo", "sar", "elint", "mixed"], description: "Payload mix." }),
        attr("cueLatencyMin", "number", { unit: "min", description: "Tasking-to-product latency." }),
      ],
      { domain: "space", icon: "Satellite" }
    ),

    // ------------------------------------------------------------ facilities
    cls(
      "facility",
      "Facility",
      "entity",
      "facility",
      "Fixed installation with a footprint on the theater map. Facilities anchor logistics, sensing and command.",
      [
        attr("hardened", "boolean", { description: "Protected against precision strike." }),
        attr("footprintKm2", "number", { unit: "km²", description: "Site footprint." }),
        attr("powerRedundancy", "number", { description: "Independent power sources." }),
      ],
      { icon: "Building2" }
    ),
    cls(
      "facility.radar-site",
      "Radar site",
      "facility",
      "facility",
      "Fixed early-warning or coastal surveillance radar feeding the air/surface picture and cueing fire units.",
      [
        attr("band", "enum", { enumValues: ["VHF", "L", "S", "X"], description: "Primary operating band." }),
        attr("instrumentedRangeKm", "number", { ...KM, description: "Instrumented detection range." }),
        attr("mastHeightM", "number", { unit: "m", description: "Antenna mast height." }),
      ],
      { domain: "land", icon: "Radar" }
    ),
    cls(
      "facility.command-post",
      "Command post",
      "facility",
      "facility",
      "Joint command node fusing the recognized picture and issuing tasking to subordinate formations.",
      [
        attr("staffCapacity", "number", { unit: "persons", description: "Battle staff positions." }),
        attr("commsRedundancy", "number", { description: "Independent communication bearers." }),
        attr("continuitysite", "boolean", { description: "Alternate site available." }),
      ],
      { domain: "land", icon: "Landmark" }
    ),
    cls(
      "facility.logistics-depot",
      "Logistics depot",
      "facility",
      "facility",
      "Fuel and munitions depot sustaining island garrisons; a critical vulnerability node.",
      [
        attr("fuelStockT", "number", { unit: "t", description: "Fuel on hand." }),
        attr("munitionsStockT", "number", { unit: "t", description: "Munitions on hand." }),
        attr("throughputTPerDay", "number", { unit: "t/day", description: "Issue/receipt throughput." }),
      ],
      { domain: "land", icon: "Warehouse" }
    ),
    cls(
      "facility.airfield",
      "Airfield",
      "facility",
      "facility",
      "Runway complex generating land-based air sorties and hosting dispersal operations.",
      [
        attr("runwayLengthM", "number", { unit: "m", description: "Primary runway length." }),
        attr("aprons", "number", { description: "Parking aprons." }),
        attr("sortieCapacity", "number", { unit: "sorties/day", description: "Daily sortie generation capacity." }),
      ],
      { domain: "land", icon: "Plane" }
    ),

    // --------------------------------------------------------------- systems
    cls(
      "system",
      "System",
      "entity",
      "system",
      "Equipment carried by units and facilities: sensors and weapons with typed performance envelopes.",
      [
        attr("designation", "string", { description: "System designation." }),
        attr("generation", "number", { description: "Technology generation." }),
        attr("reliability", "number", { ...PCT, description: "Mission reliability." }),
      ],
      { icon: "Cpu" }
    ),
    cls(
      "system.sensor",
      "Sensor",
      "system",
      "system",
      "Detection system producing contacts for the observation API within a range envelope.",
      [
        attr("rangeKm", "number", { ...KM, description: "Nominal detection range." }),
        attr("mode", "enum", { enumValues: ["active", "passive"], description: "Emission mode." }),
        attr("scanRateRpm", "number", { unit: "rpm", description: "Scan rate." }),
      ],
      { icon: "Eye" }
    ),
    cls(
      "system.surface-radar",
      "Surface search radar",
      "system.sensor",
      "system",
      "Horizon-limited radar for surface contacts and navigation.",
      [
        attr("rangeKm", "number", { ...KM, description: "Instrumented range." }),
        attr("seaClutterFilter", "boolean", { description: "Clutter suppression in high sea states." }),
        attr("horizonLimited", "boolean", { description: "Detection bounded by radar horizon." }),
      ],
      { icon: "Radar" }
    ),
    cls(
      "system.air-search-radar",
      "Air search radar",
      "system.sensor",
      "system",
      "Volume search radar building the air picture and cueing air-defense engagements.",
      [
        attr("rangeKm", "number", { ...KM, description: "Instrumented range." }),
        attr("maxAltitudeM", "number", { unit: "m", description: "Altitude coverage ceiling." }),
        attr("trackCapacity", "number", { description: "Simultaneous tracks." }),
      ],
      { icon: "Radar" }
    ),
    cls(
      "system.sonar",
      "Sonar",
      "system.sensor",
      "system",
      "Acoustic sensor for sub-surface detection; performance varies with array type and sea state.",
      [
        attr("rangeKm", "number", { ...KM, description: "Nominal detection range." }),
        attr("arrayType", "enum", { enumValues: ["hull", "towed", "dipping", "sonobuoy"], description: "Array configuration." }),
        attr("convergenceZone", "boolean", { description: "Convergence-zone detection modeled." }),
      ],
      { icon: "Waves" }
    ),
    cls(
      "system.weapon",
      "Weapon",
      "system",
      "system",
      "Engagement system with range, single-shot kill probability and magazine depth.",
      [
        attr("rangeKm", "number", { ...KM, description: "Maximum engagement range." }),
        attr("pk", "number", { description: "Single-shot probability of kill, 0-1." }),
        attr("ammo", "number", { unit: "rounds", description: "Magazine depth." }),
      ],
      { icon: "Crosshair" }
    ),
    cls(
      "system.ssm",
      "Anti-ship missile",
      "system.weapon",
      "system",
      "Surface- or air-launched anti-ship cruise missile with terminal seeker.",
      [
        attr("seeker", "enum", { enumValues: ["active-radar", "passive-rf", "eo-ir"], description: "Terminal guidance." }),
        attr("cruiseAltitudeM", "number", { unit: "m", description: "Sea-skimming cruise altitude." }),
        attr("salvoSize", "number", { description: "Typical rounds per salvo." }),
      ],
      { icon: "Rocket" }
    ),
    cls(
      "system.sam",
      "Surface-to-air missile",
      "system.weapon",
      "system",
      "Air-defense missile engaging aircraft and, at reduced probability, incoming missiles.",
      [
        attr("guidance", "enum", { enumValues: ["command", "semi-active", "active"], description: "Guidance mode." }),
        attr("interceptAltitudeM", "number", { unit: "m", description: "Maximum intercept altitude." }),
        attr("reactionTimeS", "number", { unit: "s", description: "Detection-to-launch reaction time." }),
      ],
      { icon: "Target" }
    ),

    // ---------------------------------------------------------------- events
    cls(
      "event",
      "Event",
      "entity",
      "event",
      "Timestamped occurrence recorded on the deduction timeline and replayable from snapshots.",
      [
        attr("at", "string", { description: "Simulation time of occurrence (ISO or sim hours)." }),
        attr("severity", "enum", { enumValues: ["neutral", "good", "warn", "danger", "info"], description: "Display severity." }),
        attr("location", "latlng", { description: "Where the event occurred." }),
      ],
      { icon: "Activity" }
    ),
    cls(
      "event.detection",
      "Detection event",
      "event",
      "event",
      "A sensor gained or refined a contact on an opposing unit.",
      [
        attr("sensorClassId", "string", { description: "Detecting sensor class." }),
        attr("confidence", "number", { ...PCT, description: "Track confidence." }),
        attr("emissionsDetected", "boolean", { description: "Contact gained passively from emissions." }),
      ],
      { icon: "Eye" }
    ),
    cls(
      "event.engagement",
      "Engagement event",
      "event",
      "event",
      "A weapon employment against a detected target, with adjudicated outcome.",
      [
        attr("weaponClassId", "string", { description: "Employing weapon class." }),
        attr("roundsExpended", "number", { unit: "rounds", description: "Rounds fired." }),
        attr("outcome", "enum", { enumValues: ["hit", "miss", "partial"], description: "Adjudicated result." }),
      ],
      { icon: "Zap" }
    ),
    cls(
      "event.cyber-attack",
      "Cyber attack event",
      "event",
      "event",
      "A non-kinetic effect delivered against networks, sensors or command nodes.",
      [
        attr("vector", "enum", { enumValues: ["network", "rf-injection", "supply-chain"], description: "Attack vector." }),
        attr("degradation", "number", { ...PCT, description: "Capability degradation inflicted." }),
        attr("durationH", "number", { unit: "h", description: "Effect duration." }),
      ],
      { icon: "Bug" }
    ),

    // -------------------------------------------------------------- concepts
    cls(
      "concept.objective",
      "Objective",
      "entity",
      "concept",
      "A scored mission objective: control an area, destroy or protect entities, deliver a force, or deny access.",
      [
        attr("kind", "enum", {
          enumValues: ["control-area", "destroy", "protect", "deliver", "deny"],
          description: "Objective type.",
        }),
        attr("weight", "number", { description: "Relative weight in the side score, 0-1." }),
        attr("deadlineH", "number", { unit: "h", description: "Latest achievement time." }),
      ],
      { icon: "Flag" }
    ),
    cls(
      "concept.coa",
      "Course of action",
      "entity",
      "concept",
      "A phased plan assigning units to sub-tasks along waypoint routes, scored for feasibility and risk.",
      [
        attr("approach", "string", { description: "One-line doctrine label." }),
        attr("phaseCount", "number", { description: "Number of phases." }),
        attr("riskScore", "number", { description: "Composite risk, 0-100." }),
      ],
      { icon: "GitBranch" }
    ),
    cls(
      "concept.task-force",
      "Task force",
      "entity",
      "concept",
      "Command grouping of force units under a single commander for a phase of the operation.",
      [
        attr("commander", "string", { description: "Commanding officer." }),
        attr("composition", "number", { unit: "units", description: "Assigned unit count." }),
        attr("missionStatement", "string", { description: "Assigned mission." }),
      ],
      { icon: "Users" }
    ),
  ];

  const relations = [
    rel("rel-subordinate-to", "subordinateTo", "force-unit", "force-unit", "A force unit reports to a higher-echelon unit in the command chain."),
    rel("rel-assigned-to", "assignedTo", "force-unit", "concept.task-force", "A force unit is grouped under a task force for the operation."),
    rel("rel-has-sensor", "hasSensor", "force-unit", "system.sensor", "A force unit carries a sensor system contributing detections."),
    rel("rel-has-weapon", "hasWeapon", "force-unit", "system.weapon", "A force unit carries a weapon system available for engagements."),
    rel("rel-detects", "detects", "system.sensor", "force-unit", "A sensor holds a track on a force unit within its range envelope."),
    rel("rel-engages", "engages", "system.weapon", "force-unit", "A weapon system is employed against a detected force unit."),
    rel("rel-defends", "defends", "land.sam-battalion", "facility", "A SAM battalion provides air-defense coverage over a facility."),
    rel("rel-threatens", "threatens", "land.coastal-battery", "maritime.unit", "A coastal battery holds maritime units inside its weapon engagement zone at risk."),
    rel("rel-cued-by", "cuedBy", "land.sam-battalion", "facility.radar-site", "A fire unit receives target cueing from a surveillance radar site."),
    rel("rel-supplied-by", "suppliedBy", "force-unit", "facility.logistics-depot", "A force unit draws fuel and munitions from a depot."),
    rel("rel-replenished-by", "replenishedBy", "maritime.unit", "maritime.auxiliary", "A ship replenishes underway from a fleet auxiliary."),
    rel("rel-based-at", "basedAt", "air.unit", "facility.airfield", "An air unit generates sorties from an airfield."),
    rel("rel-embarked-on", "embarkedOn", "land.marine-battalion", "maritime.amphibious", "A landing force is embarked aboard an amphibious ship until the assault phase."),
    rel("rel-screens", "screens", "maritime.destroyer", "maritime.carrier", "An escort maintains a defensive screen sector around the high-value unit."),
    rel("rel-reports-via", "reportsVia", "force-unit", "facility.command-post", "A force unit passes its recognized picture through a command node."),
    rel("rel-degrades", "degrades", "cyber.ops-cell", "facility.command-post", "A cyber cell delivers non-kinetic degradation against a command node."),
    rel("rel-targets", "targets", "concept.objective", "entity", "An objective designates entities or areas to be affected for score."),
  ];

  return {
    version: "2.4.1",
    updatedAt: "2026-08-11T14:20:00Z",
    classes,
    relations,
  };
}
