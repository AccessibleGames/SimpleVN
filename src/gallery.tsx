import { useEffect, useState } from "preact/hooks";
import { t } from "./i18n";
import type { GalleryEntry } from "./game";

interface GalleryProps {
  title: string;
  entries: GalleryEntry[];
  /** Base path for art/, bg/ and sprites/. */
  assets: string;
  onExit: () => void;
}

export function Gallery({ title, entries, assets, onExit }: GalleryProps) {
  const artBase = `${assets}art/`;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    if (openIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenIndex(null);
      else if (event.key === "ArrowRight") setOpenIndex((i) => (i === null ? i : (i + 1) % entries.length));
      else if (event.key === "ArrowLeft")
        setOpenIndex((i) => (i === null ? i : (i - 1 + entries.length) % entries.length));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIndex, entries.length]);

  const current = openIndex === null ? null : entries[openIndex];

  return (
    <main class="gallery">
      <header class="gallery-head">
        <button class="btn-text" type="button" onClick={onExit}>
          {t("gallery.back")}
        </button>
        <span class="gallery-title">{title}</span>
        <span class="gallery-count">{entries.length}</span>
      </header>

      {entries.length === 0 ? (
        <p class="gallery-empty">{t("gallery.empty")}</p>
      ) : (
        <ul class="gallery-grid">
          {entries.map((entry, index) => (
            <li key={entry.id}>
              <button
                type="button"
                class="gallery-cell"
                aria-label={entry.label}
                onClick={() => setOpenIndex(index)}
              >
                <img
                  src={artBase + entry.thumb}
                  alt={entry.label}
                  loading="lazy"
                  decoding="async"
                  width={entry.w}
                  height={entry.h}
                />
                <span class="gallery-cell-label">{entry.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {current && openIndex !== null && (
        <div class="gallery-viewer" role="dialog" aria-modal="true" aria-label={current.label}>
          <img class="gallery-full" src={artBase + current.full} alt={current.label} decoding="async" />
          <div class="gallery-bar">
            <button
              type="button"
              class="btn-text"
              onClick={() => setOpenIndex((openIndex - 1 + entries.length) % entries.length)}
            >
              {t("gallery.prev")}
            </button>
            <span class="gallery-position">
              {openIndex + 1} / {entries.length}
            </span>
            <button
              type="button"
              class="btn-text"
              onClick={() => setOpenIndex((openIndex + 1) % entries.length)}
            >
              {t("gallery.next")}
            </button>
            <button type="button" class="btn-text" onClick={() => setOpenIndex(null)}>
              {t("contents.close")}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
