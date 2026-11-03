# Third-party notices

Tavern Map is a private prototype. Its build bundles MapLibre GL JS and loads
map data, geocoding, POI and encyclopedia content from third-party services.

## MapLibre GL JS

Bundled in `dist/index.js` and `dist/maplibre-gl-worker.js`.

```text
Copyright (c) 2023, MapLibre contributors

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of MapLibre GL JS nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

MapLibre also contains code from mapbox-gl-js v1.13 and earlier, distributed
under a BSD-3-Clause license. The full upstream notice is in
`node_modules/maplibre-gl/LICENSE.txt`.

## Data and content

- Map data © OpenStreetMap contributors, ODbL 1.0.
- OpenFreeMap provides the default vector style and tiles.
- Photon and BigDataCloud provide reverse geocoding.
- Overpass API and the OpenStreetMap API provide nearby POI data.
- OSRM / FOSSGIS provide walking route geometry and turn-by-turn steps.
- Wikipedia text is CC BY-SA 4.0. The injected scene block keeps a
  `(CC BY-SA 4.0)` label and asks the model not to reproduce long passages.

These services are used directly from the browser. Their terms and availability
can change; review them before publishing or redistributing this extension.
