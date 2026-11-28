import { describe, expect, it } from "vitest";
import type { ProjectManifest } from "../../src/shared/domain";
import { hasUnsavedUserEdits } from "../../src/renderer/project-leave-guard";

/** A fresh default project, mirroring main-process createProject() on user-editable fields. */
function freshProject(): ProjectManifest {
  return {
    schemaVersion: 13,
    id: "fresh",
    name: "我的素材專案",
    sourcePolicy: "READ_ONLY",
    previewPolicy: "DERIVED_CACHE_ONLY_NOT_MASTER",
    previewerVersion: "preview-v5-orientation-planar-safe",
    sortMode: "SMART_SEQUENCE",
    createdAt: "2026-11-28T00:00:00.000Z",
    updatedAt: "2026-11-28T00:00:00.000Z",
    sources: [],
    timelineOrder: [],
    timelineTransitionSeconds: 0.3,
    pendingAssetIds: [],
    excludedMainAssetIds: [],
    recentMainRemovals: [],
    introSegments: [],
    introTargetDurationMs: 90_000,
    introSegmentMaxDurationMs: 15_000,
    colorSettings: { introPresetId: "NATURAL", applyToMain: false },
    introExcludedSegmentIds: [],
    recentIntroRemovals: [],
    placementDecisions: [],
    mediaInsertions: [],
    mainStartCue: { enabled: true, durationMs: 650 },
    photoSoundEffect: {
      id: "DUNES_CAMERA_SHUTTER_CLICK_14671",
      displayName: "沙丘前案相機快門（Camera Shutter Click）",
      sourceProject: "草漯沙丘地質公園 YT長片",
      sourceUrl: "https://pixabay.com/sound-effects/technology-camera-shutter-click-14671/",
      licenseUrl: "https://pixabay.com/service/license-summary/",
      sha256: "0AC71ECABF302784F5FFB9483C2939C46B1784AA0D016A322CB6D1A0ECA07B93",
      volumePercent: 70,
    },
    bgmTracks: [],
    sourceAudioVolumePercent: 100,
    aiStoryContext: {
      topic: "",
      locations: [],
      people: [],
      storySummary: "",
      audiencePromise: "",
      subtitleLanguage: "zh",
    },
    subtitleCues: [],
    timelineRevision: 0,
    subtitleTimelineRevision: 0,
    audioMixPolicy: "ORIGINAL_PLUS_BGM_LIMITED_0_95",
  } as ProjectManifest;
}

describe("hasUnsavedUserEdits", () => {
  it("is false for a brand-new empty project", () => {
    expect(hasUnsavedUserEdits(freshProject())).toBe(false);
  });

  it("is true when only the AI story context was edited", () => {
    const project = freshProject();
    project.aiStoryContext = { ...project.aiStoryContext, topic: "河內慢遊" };
    expect(hasUnsavedUserEdits(project)).toBe(true);
  });

  it("is true when only a settings field was edited", () => {
    const project = freshProject();
    project.sourceAudioVolumePercent = 80;
    expect(hasUnsavedUserEdits(project)).toBe(true);

    const colored = freshProject();
    colored.colorSettings = { introPresetId: "NATURAL", applyToMain: true };
    expect(hasUnsavedUserEdits(colored)).toBe(true);
  });

  it("is false when only derived meta fields changed", () => {
    const project = freshProject();
    project.updatedAt = "2026-11-28T09:00:00.000Z";
    project.timelineRevision = 7;
    expect(hasUnsavedUserEdits(project)).toBe(false);
  });

  it("treats a missing optional field the same as its default", () => {
    const project = freshProject();
    delete project.watermarkSettings;
    delete project.sourceAudioVolumePercent;
    expect(hasUnsavedUserEdits(project)).toBe(false);
  });
});
