# Output format for verified product research

Write ONE JSON file: an object { "products": [...], "compatibility": [...], "notes": [...] }.

Every product object:
{
  "manufacturer": "Hikvision",            // legal brand as printed on datasheet
  "family": "Hikvision",                  // brand/family: "TP-Link VIGI", "HiLook", "Hikvision", "TVT", "Dahua", "Tiandy", "Uniview", "Ajax", "Axis", "Hanwha", "WD Purple", "Seagate SkyHawk"
  "model": "DS-2CD2386G2-IU",             // exact orderable model, include lens variant if the model code has one
  "category": "camera" | "nvr" | "hdd" | "junction_box" | "wall_bracket" | "pole_bracket" | "poe_switch" | "kit",
  "sourceUrl": "https://...",             // manufacturer product page or datasheet PDF you actually read
  "verifiedAt": "2026-10-02",
  "specs": { ... only fields you verified, see below ... },
  "unverified": ["fieldName", ...]        // fields you looked for but could not verify (omit them from specs)
}

Camera specs (omit anything not printed by the manufacturer/reliable supplier):
  formFactor: "turret"|"bullet"|"dome"|"pt"|"ptz"|"fisheye"|"box"|"other"
  resolutionMp (number), horizontalPixels, verticalPixels (max main-stream resolution)
  lensMm: number (fixed) or [min,max] (varifocal); lensOptions: [2.8, 4] if the model is sold in several fixed lenses (then also give hfovByLensDeg: {"2.8": 103, "4": 84})
  hfovDeg: horizontal FOV for THIS model/lens
  codecs: ["H.265+","H.265","H.264+","H.264", ...]
  bitrateKbps: [min, max] as published for the main stream
  wdrDb: number if "120 dB WDR" (true WDR); if only "DWDR", put wdrType: "digital"
  irRangeM, whiteLightRangeM
  colourNight: true if the camera is marketed as full-colour at night (ColorVu, Full-Color, etc.)
  microphone: true/false, speaker: true/false (built-in only)
  activeDeterrence: ["strobe light","siren"] if built in
  analytics: normalised keys where printed: "human_vehicle", "line_crossing", "intrusion", "region_entrance", "region_exit", "face_detection", "lpr", "people_counting", "loitering", "smart_search", "audio_exception" (add others as free text)
  poeMaxW: number (max power consumption), poeStandard: "802.3af" | "802.3at", dcInput: "12 VDC"
  ingress: ["IP67"], vandal: "IK10"
  operatingTempC: [min, max], operatingHumidity: "≤95%"
  onvifProfiles: ["S","G","T"] only if printed
  ecosystem: ["Hik-Connect","HikCentral"], or ["VIGI app","VIGI Security Manager"], etc.
  storage: "microSD up to 512 GB" if built in

NVR specs:
  channels, poePorts, poePerPortW, poeBudgetW, poeStandard
  incomingMbps, outgoingMbps
  recordingResolutionMaxMp
  decoding: { "<MP>": <simultaneous channels>, ... } e.g. {"12": 1, "8": 2, "4": 4, "1080p": 8} copied from the "Decoding capability" line; also put decodingText: the exact printed line
  hddBays, maxHddTb (per disk), maxTotalTb (= bays × per-disk if printed that way)
  codecs (decoding formats), analytics (what the NVR supports with compatible cameras), onvif: true/false, onvifProfiles if printed
  alarmIn, alarmOut, audioIn, audioOut
  ecosystem: [...], compatibleFamilies: ["Hikvision","HiLook"] only if the manufacturer says so
  hdmiOutput, vgaOutput

HDD specs: capacityTb, surveillanceRated: true, recommendedBays (e.g. "up to 8 bays"), workloadTbYr, cache MB, rpm or "5400 RPM class", warrantyYears, maxCameras if printed (e.g. "up to 64 cameras")

Junction box / bracket specs: compatibleModels: [exact camera models the manufacturer lists], material, ingress, dimensionsMm

Kit specs: components: [{ "model": "...", "qty": 4 }, ...] — every component must also appear as its own product.

compatibility entries:
  { "kind": "camera_junction_box" | "camera_wall_bracket" | "camera_pole_bracket" | "camera_nvr" | "nvr_hdd" | "kit_component",
    "from": "<model>", "to": "<model>", "qty": 1, "sourceUrl": "https://...", "note": "listed under Accessories on the camera datasheet" }
  Only add compatibility the manufacturer documents (accessory list on datasheet/product page, compatibility list, kit contents).

RULES
- Do NOT guess, infer, or fill a value from a similar model. If not printed for this exact model, leave it out and list it in "unverified".
- Prefer the NZ/AU regional manufacturer site where it exists; otherwise the global manufacturer site or the official datasheet PDF.
- A reputable NZ/AU distributor page (IT Plus, Clear Digital, Security Wholesale/SWL, Atlas Gentech, IOT Technologies) is acceptable as a source only if the manufacturer page cannot be reached; say so in notes.
- Never include prices.
- Prefer current, orderable models (not discontinued).
