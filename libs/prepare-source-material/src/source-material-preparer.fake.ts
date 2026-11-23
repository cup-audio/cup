import {
  assertPublicSourceUrl,
  prepareLoadedSourcePage,
  VISIBLE_HEADLINE_ATTRIBUTE,
  type CoverImageDeclaration,
  type DeclaredLanguage,
  type SourceMaterialPreparer,
} from "#src/prepare-source-material.ts";

export type ControlledSourceMaterialPreparerOptions = {
  url: string;
  html: string;
  coverImage?: CoverImageDeclaration;
  declaredLanguage?: DeclaredLanguage;
};

export function createControlledSourceMaterialPreparer({
  url: controlledUrl,
  html,
  coverImage,
  declaredLanguage,
}: ControlledSourceMaterialPreparerOptions): SourceMaterialPreparer {
  assertPublicSourceUrl(controlledUrl);

  return async (url) => {
    if (url !== controlledUrl) {
      throw new Error(`Unexpected controlled source URL: ${url}`);
    }

    return prepareLoadedSourcePage({
      bodyHtml: html.replace("<h1", `<h1 ${VISIBLE_HEADLINE_ATTRIBUTE}`),
      documentTitle: "Controlled source fixture",
      ...(coverImage === undefined ? {} : { coverImage }),
      ...(declaredLanguage === undefined ? {} : { declaredLanguage }),
      fetchedUrl: url,
      responseStatus: 200,
    });
  };
}
