// SPEC-037 §4.11 — the phone matrix. Every `*.phone.spec.ts` file runs in the
// `phone-landscape` project (a Chromium phone: touch, `isMobile`, a 2.625
// ratio) and iterates these sizes, one `test.describe` and one
// `test.use({ viewport })` per size. Later specs add their own files to the
// same project; the sizes are shared so every one of them is checked against
// the same screens.
//
// Landscape only: an upright phone is still SPEC-036's rotate cover (37-i).
export interface PhoneViewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export const PHONE_VIEWPORTS: readonly PhoneViewport[] = [
  // A 6.1" iPhone on its side.
  { name: 'phone-844', width: 844, height: 390 },
  // A 360-dp Android — the compact arc's size.
  { name: 'phone-800', width: 800, height: 360 },
  { name: 'phone-750', width: 750, height: 342 },
  // A Pixel 5 on its side, with Chrome's bars: the shortest screen in the set.
  { name: 'phone-802', width: 802, height: 293 },
  // The 4.7" iPhone SE — the narrowest.
  { name: 'phone-667', width: 667, height: 375 },
  // A tablet: monitor-sized, touched.
  { name: 'tablet-1180', width: 1180, height: 820 },
];
