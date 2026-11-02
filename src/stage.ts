/**
 * Minimal WebGL2 stage compositor: a background plus a few sprite layers, drawn
 * through one camera transform.
 *
 * Why not CSS: the camera moves continuously (tilt-driven), and scaling a
 * composited layer by CSS makes the browser re-rasterise or sample a stale
 * raster, which shows up as blur or jitter on a phone. Sampling the texture
 * every frame keeps the image at native resolution and costs one uniform write.
 *
 * Design space is the game's native resolution (1024x768 here); "cover" maps it
 * to the viewport so a 4:3 stage fills a tall phone screen, leaving the camera
 * room to pan.
 */

export const COVER = "cover";

export interface StageLayer {
  /** Image URL; textures are cached and decoded off the main thread. */
  url: string;
  /** Placement in design space, in design pixels. */
  x: number;
  y: number;
  /** Width in design pixels; height follows the image's aspect ratio. */
  width?: number;
  /** Multiplier on the natural size, when width is not given. */
  scale?: number;
  alpha?: number;
  /** Anchor: 0 = top-left of the box, 0.5 = centred, 1 = bottom-right. */
  anchorX?: number;
  anchorY?: number;
}

export interface Camera {
  /** Design-space point shown at the viewport centre. */
  x: number;
  y: number;
  zoom: number;
}

export interface StageOptions {
  designWidth: number;
  designHeight: number;
  /** How many decoded textures to keep; phones have a small texture budget. */
  cacheSize?: number;
}

export interface Stage {
  /** Replace the layer list. Textures load asynchronously and draw on arrival. */
  setLayers(layers: StageLayer[]): void;
  setCamera(camera: Camera): void;
  /** Redraw after a camera change; cheap and safe to call every frame. */
  render(): void;
  /** Re-read the canvas size and viewport. */
  resize(): void;
  /** Resolve once every currently requested texture is decoded. */
  ready(): Promise<void>;
  destroy(): void;
  /** True while the GPU context is lost; the stage recovers on restore. */
  readonly lost: boolean;
  /** Camera travel available before an edge would show, in design pixels. */
  panRoom(): { x: number; y: number };
}

const VERTEX = `#version 300 es
in vec2 a_unit;

uniform vec2 u_resolution;
uniform vec2 u_camera;
uniform float u_scale;
uniform vec2 u_offset;
uniform vec2 u_size;

out vec2 v_uv;

void main() {
  vec2 world = u_offset + a_unit * u_size;
  vec2 view = (world - u_camera) * u_scale;
  // view is in pixels relative to the viewport centre; NDC spans half of each axis
  vec2 clip = vec2(view.x / (u_resolution.x * 0.5), -view.y / (u_resolution.y * 0.5));
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_unit;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;

in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_alpha;

out vec4 outColor;

void main() {
  // textures are uploaded premultiplied, so the blend math stays simple
  outColor = texture(u_texture, v_uv) * u_alpha;
}`;

interface Texture {
  bitmap: ImageBitmap;
  handle: WebGLTexture;
  width: number;
  height: number;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`stage shader: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`stage link: ${log}`);
  }
  return program;
}

export function createStage(canvas: HTMLCanvasElement, options: StageOptions): Stage {
  const { designWidth, designHeight, cacheSize = 8 } = options;

  let gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 unavailable");

  let program = link(gl);
  let quad = gl.createBuffer();
  const locations = {
    unit: gl.getAttribLocation(program, "a_unit"),
    resolution: gl.getUniformLocation(program, "u_resolution"),
    camera: gl.getUniformLocation(program, "u_camera"),
    scale: gl.getUniformLocation(program, "u_scale"),
    offset: gl.getUniformLocation(program, "u_offset"),
    size: gl.getUniformLocation(program, "u_size"),
    texture: gl.getUniformLocation(program, "u_texture"),
    alpha: gl.getUniformLocation(program, "u_alpha"),
  };

  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(locations.unit);
  gl.vertexAttribPointer(locations.unit, 2, gl.FLOAT, false, 0, 0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  const textures = new Map<string, Texture>();
  const pending = new Map<string, Promise<void>>();
  /** Insertion order doubles as the LRU order: Map keeps it. */
  const usage: string[] = [];

  let layers: StageLayer[] = [];
  let camera: Camera = { x: designWidth / 2, y: designHeight / 2, zoom: 1 };
  let lost = false;

  function touch(url: string): void {
    const index = usage.indexOf(url);
    if (index >= 0) usage.splice(index, 1);
    usage.push(url);
    while (usage.length > cacheSize) {
      const evict = usage.shift();
      if (!evict) break;
      const texture = textures.get(evict);
      if (texture && gl) {
        gl.deleteTexture(texture.handle);
        texture.bitmap.close();
        textures.delete(evict);
      }
    }
  }

  function upload(texture: Texture): void {
    if (!gl) return;
    texture.handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture.handle);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture.bitmap);
    // No mipmaps: camera zoom stays near 1, and generating them costs CPU per image.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function load(url: string): Promise<void> {
    const existing = pending.get(url);
    if (existing) return existing;

    const job = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`stage: ${response.status} ${url}`);
      // decodeImageBitmap runs off the main thread, unlike <img> decoding
      const bitmap = await createImageBitmap(await response.blob());
      if (lost) {
        bitmap.close();
        return;
      }
      const texture: Texture = { bitmap, handle: null as unknown as WebGLTexture, width: bitmap.width, height: bitmap.height };
      upload(texture);
      textures.set(url, texture);
      touch(url);
      render();
    })().catch((error) => {
      console.warn(String(error));
    });

    pending.set(url, job);
    return job;
  }

  function viewport(): { width: number; height: number; scale: number } {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    return {
      width,
      height,
      // cover: fill the viewport, cropping the overflowing axis
      scale: Math.max(width / designWidth, height / designHeight) * camera.zoom,
    };
  }

  function render(): void {
    if (!gl || lost) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round((canvas.clientWidth || 1) * dpr);
    const height = Math.round((canvas.clientHeight || 1) * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const view = viewport();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(locations.unit);
    gl.vertexAttribPointer(locations.unit, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(locations.resolution, view.width, view.height);
    gl.uniform2f(locations.camera, camera.x, camera.y);
    gl.uniform1f(locations.scale, view.scale);
    gl.uniform1i(locations.texture, 0);
    gl.activeTexture(gl.TEXTURE0);

    for (const layer of layers) {
      const texture = textures.get(layer.url);
      if (!texture) {
        void load(layer.url);
        continue;
      }
      touch(layer.url);

      const width = layer.width ?? texture.width * (layer.scale ?? 1);
      const height = (width / texture.width) * texture.height;
      const anchorX = layer.anchorX ?? 0;
      const anchorY = layer.anchorY ?? 0;

      gl.uniform2f(locations.offset, layer.x - width * anchorX, layer.y - height * anchorY);
      gl.uniform2f(locations.size, width, height);
      gl.uniform1f(locations.alpha, layer.alpha ?? 1);
      if (import.meta.env.DEV) {
        const trace = ((
          (window as unknown as { __stageTrace?: unknown[] }).__stageTrace ??= []
        ) as unknown[]);
        trace.push({
          url: layer.url.split("/").pop(),
          quad: [layer.x - width * anchorX, layer.y - height * anchorY, width, height],
          tex: [texture.width, texture.height],
          view: [view.width, view.height, view.scale],
          camera: [camera.x, camera.y],
        });
        if (trace.length > 12) trace.shift();
      }
      gl.bindTexture(gl.TEXTURE_2D, texture.handle);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  function onLost(event: Event): void {
    event.preventDefault();
    lost = true;
    for (const texture of textures.values()) {
      texture.bitmap.close();
    }
    textures.clear();
    pending.clear();
  }

  function onRestored(): void {
    lost = false;
    gl = canvas.getContext("webgl2");
    if (!gl) return;
    program = link(gl);
    quad = gl.createBuffer();
    locations.unit = gl.getAttribLocation(program, "a_unit");
    locations.resolution = gl.getUniformLocation(program, "u_resolution");
    locations.camera = gl.getUniformLocation(program, "u_camera");
    locations.scale = gl.getUniformLocation(program, "u_scale");
    locations.offset = gl.getUniformLocation(program, "u_offset");
    locations.size = gl.getUniformLocation(program, "u_size");
    locations.texture = gl.getUniformLocation(program, "u_texture");
    locations.alpha = gl.getUniformLocation(program, "u_alpha");
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    for (const layer of layers) void load(layer.url);
    render();
  }

  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const observer = new ResizeObserver(() => render());
  observer.observe(canvas);

  return {
    setLayers(next) {
      layers = next;
      render();
    },
    setCamera(next) {
      camera = next;
    },
    panRoom() {
      const view = viewport();
      // How far the camera can move before the viewport leaves the image.
      return {
        x: Math.max(0, (designWidth - view.width / view.scale) / 2),
        y: Math.max(0, (designHeight - view.height / view.scale) / 2),
      };
    },
    render,
    resize: render,
    async ready() {
      await Promise.allSettled([...pending.values()]);
    },
    destroy() {
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      for (const texture of textures.values()) {
        gl?.deleteTexture(texture.handle);
        texture.bitmap.close();
      }
      textures.clear();
    },
    get lost() {
      return lost;
    },
  };
}
