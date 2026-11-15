"""Static description of the mission site: map layers, default plan, parameter ranges and data sources."""
from __future__ import annotations

SITE = {
    "name": "Mount Sharp boxwork region, Gale Crater",
    "summary": ("Crisscrossing mineral ridges left where groundwater once flowed through cracks in the rock. "
                "Curiosity has studied them since 2025; a crew on foot can sample ridge tops, hollows and the layers above."),
    "science_goal": "Sample boxwork ridges and hollows to learn when and how long groundwater flowed on Mount Sharp.",
}

# NASA/JPL "Where is Curiosity" map tiles (Web Mercator, TMS row order).
TILES = {
    "context": {
        "label": "Regional imagery (CTX, 6 m)",
        "url": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/MSL_CTX_ortho_mosaic_6m/{z}/{x}/{y}.png",
        "tms": True, "min_zoom": 6, "max_native_zoom": 13,
        "bounds": [[-7.8441, 135.9788], [-3.3971, 139.4859]],
        "attribution": "NASA/JPL-Caltech/MSSS",
    },
    "basemap": {
        "label": "Colour imagery (HiRISE, 25 cm)",
        "url": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/MSL_Gale_HiRISE-LRGB_78quads/{z}/{x}/{y}.png",
        "tms": True, "min_zoom": 10, "max_native_zoom": 18,
        "bounds": [[-4.8756, 137.3267], [-4.5551, 137.4786]],
        "attribution": "NASA/JPL-Caltech/University of Arizona",
    },
    "labels": {
        "label": "Place names",
        "url": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/MSL_WebGIS_PlaceText/{z}/{x}/{y}.png",
        "tms": True, "min_zoom": 4, "max_native_zoom": 17,
        "bounds": [[-6.3335, 136.4997], [-4.1306, 138.1995]],
        "attribution": "NASA/JPL-Caltech",
    },
}

# ---- the base rover, for the drive mode ------------------------------------------------------------------
# Physical constants of Mars are measured values. The rover is an estimate for a crew of three, scaled from NASA's
# Space Exploration Vehicle concept (two crew, commonly listed at about 3,000 kg), with a storm shelter added.
MARS = {
    "gravity_m_s2": 3.73,       # NASA Mars fact sheet, mean surface gravity (Earth: 9.81)
    "air_density_kg_m3": 0.016,  # NASA Mars fact sheet, surface density (about 1.3 % of Earth's)
}
MARS_SOURCE = {"name": "NASA Mars fact sheet", "url": "https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html"}

ROVER_MASS_BUILDUP = [  # (what, kg, how the figure was arrived at)
    ("Chassis, six wheels, suspension and hub motors", 1500, "about half of the SEV's 3,000 kg, made sturdier for a third person"),
    ("Pressurised cabin for three, with three suitports", 1600, "SEV-style cabin, lengthened for a third seat and bunk"),
    ("Batteries for a three-day traverse", 900, "assumed"),
    ("Life support, heating and cooling, computers and radios", 600, "assumed"),
    ("Water wall round the bunks, used as a solar-storm shelter", 500, "assumed; doubles as drinking water"),
    ("Crew of three", 240, "80 kg each"),
    ("Three spacesuits", 375, "assumed 125 kg each"),
    ("Food, water, oxygen and rock samples", 200, "assumed, three days for three people"),
]

ROVER = {
    "name": "Base rover",
    "crew": 3,
    "mass_kg": sum(kg for _, kg, _ in ROVER_MASS_BUILDUP),
    "mass_buildup": [{"what": what, "kg": kg, "basis": basis} for what, kg, basis in ROVER_MASS_BUILDUP],
    "reference": {"name": "NASA Space Exploration Vehicle (2 crew, about 3,000 kg)",
                  "url": "https://en.wikipedia.org/wiki/Space_Exploration_Vehicle"},
    **MARS,
    "mars_source": MARS_SOURCE,
    # Size (metres). Wheels sit on three axles; front and rear axles both steer.
    "length_m": 6.0, "width_m": 3.0, "height_m": 3.2,
    "wheelbase_m": 3.8, "track_m": 2.8, "wheel_radius_m": 0.6, "suspension_travel_m": 0.35,
    # Driving. Six 10 kW hub motors; electronically limited to 45 km/h (pressurised rover concepts plan 10-20 km/h).
    "drive_power_w": 60_000, "max_drive_force_n": 15_000,
    "top_speed_m_s": 12.5, "reverse_speed_m_s": 3.0, "max_steer_deg": 28,
    # Ground contact on firm, dusty bedrock: peak grip and rolling resistance as fractions of the rover's weight.
    "traction_coefficient": 0.6, "rolling_resistance": 0.06,
    "drag_area_m2": 7.0,  # drag coefficient about 0.9 times a 3.0 x 2.6 m front
}

DEFAULT_CAMP = {"lat": -4.79985, "lon": 137.38354, "name": "Base camp (pressurised rover)",
                "note": "Parked at Curiosity's Altadena drill site, on ground the rover has already driven."}
DEFAULT_STOP_SITES = ("Nevado Sajama & Valle de la Luna", "Antofagasta crater & Atacama block")
DEFAULT_WORK_MIN = 60

# name: (default, minimum, maximum, step)
PARAMETERS = {
    "flat_speed": (0.8, 0.4, 1.4, 0.1),
    "max_slope": (20, 10, 30, 1),
    "life_support_h": (8, 4, 10, 0.5),
    "reserve_min": (60, 0, 120, 15),
    "start_clock_min": (13 * 60 + 30, 6 * 60, 17 * 60, 15),
    "sunset_buffer_min": (60, 0, 120, 15),
    "storm_warning_min": (30, 10, 90, 5),
}

SOURCES = [
    {"what": "Elevation and slope", "kind": "topographic",
     "name": "MSL Gale Merged DEM, 1 m (HiRISE stereo)", "by": "USGS Astrogeology / MSL project",
     "url": "https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m"},
    {"what": "Colour and regional imagery, place names", "kind": "optical",
     "name": "Curiosity rover location map tiles (HiRISE colour, CTX)", "by": "NASA/JPL-Caltech/University of Arizona/MSSS",
     "url": "https://science.nasa.gov/mission/msl-curiosity/location-map/"},
    {"what": "Rover stops, driven path and tilt", "kind": "rover",
     "name": "Curiosity waypoints and traverse", "by": "NASA/JPL-Caltech",
     "url": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"},
    {"what": "Temperature, pressure, UV, sunrise and sunset", "kind": "atmospheric",
     "name": "Curiosity REMS daily weather report", "by": "NASA/JPL-Caltech/CAB",
     "url": "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json"},
    {"what": "Surface radiation dose rate and the May 2024 solar storm", "kind": "radiation",
     "name": "Curiosity RAD reduced data records", "by": "NASA PDS Planetary Plasma Interactions node / SwRI",
     "url": "https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/"},
    {"what": "Ground photos at rover stops", "kind": "optical",
     "name": "Curiosity raw images", "by": "NASA/JPL-Caltech",
     "url": "https://mars.nasa.gov/msl/multimedia/raw-images/"},
]

MODEL_NOTES = [
    "Walking speed follows Tobler's hiking function, scaled so level ground gives the planning speed you set; uphill and downhill differ.",
    "Ground steeper than the slope limit is treated as no-go. Slopes come from 1 m elevation data and cannot show rocks smaller than a few metres.",
    "The time limit is the tighter of usable life support (capacity minus reserve) and daylight (back before sunset minus the buffer).",
    "Radiation figures use the dose rate Curiosity measured around the chosen sol; sieverts are estimated with a mean quality factor of 3.05.",
]
