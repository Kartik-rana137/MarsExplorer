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
