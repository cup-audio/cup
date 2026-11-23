import { css } from "@linaria/core";
import React from "react";

import type { MapPropsToRequiredDataAttributeProps } from "#src/app/styling.utils.js";
import { composeClassnames } from "#src/app/utils.js";
import { TRACK_COVER_ATTRIBUTE } from "#src/app/view-transition-names.js";

type DSCoverImageProps = DSCoverImageCustomProps & {
  src: string | undefined;
  alt: string;
  className?: string;
  [TRACK_COVER_ATTRIBUTE]?: string;
};

type DSCoverImageCustomProps = {
  shape?: "rectangle" | "circle";
  corners?: "rounded" | "card";
};

type DSCoverImageDataAttributes = MapPropsToRequiredDataAttributeProps<DSCoverImageCustomProps>;

type ShownImage = { src: string; alt: string };

export function DSCoverImage({
  src,
  alt,
  shape = "rectangle",
  corners = "rounded",
  className,
  [TRACK_COVER_ATTRIBUTE]: trackCover,
}: DSCoverImageProps): React.JSX.Element {
  const [shownImage, setShownImage] = React.useState<ShownImage | undefined>(undefined);
  const dataAttributes: DSCoverImageDataAttributes = {
    "data-shape": shape,
    "data-corners": corners,
  };

  const isLoading = src !== undefined && src !== shownImage?.src;

  return (
    <div
      className={composeClassnames(
        css`
          /* containing block for the stacked images */
          position: relative;
          overflow: hidden;
          background-color: var(--color-placeholder);
          border-radius: var(--border-radius-lg);

          &[data-shape="rectangle"] {
            aspect-ratio: 5 / 3;
          }

          &[data-shape="circle"] {
            aspect-ratio: 1;
            border-radius: var(--border-radius-full);
          }

          &[data-corners="card"] {
            border-radius: 0 0 calc(var(--border-radius-lg) - 1px)
              calc(var(--border-radius-lg) - 1px);
          }

          & > img {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
          }

          & > img[data-loading] {
            opacity: 0;
          }
        `,
        className,
      )}
      {...dataAttributes}
      {...{ [TRACK_COVER_ATTRIBUTE]: trackCover }}
    >
      {src !== undefined && shownImage !== undefined && (
        <img src={shownImage.src} alt={isLoading ? shownImage.alt : alt} />
      )}
      {isLoading && (
        <img
          key={src}
          src={src}
          alt=""
          data-loading=""
          ref={(image) => {
            if (image?.complete && image.naturalWidth > 0) {
              setShownImage({ src, alt });
            }
          }}
          onLoad={() => setShownImage({ src, alt })}
        />
      )}
    </div>
  );
}
