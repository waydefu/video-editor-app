import { DEFAULT_PROJECT_COLOR_SETTINGS } from "../shared/color-presets";
import {
  DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  DEFAULT_INTRO_TARGET_DURATION_MS,
  DEFAULT_MAIN_START_CUE_SETTINGS,
  DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT,
  DUNES_SHUTTER_EFFECT_ID,
  type ProjectManifest,
} from "../shared/domain";
import { DEFAULT_WATERMARK_SETTINGS } from "../shared/watermark";

/**
 * User-editable project fields, normalized so that a missing optional field compares
 * equal to its default. Derived, cache, revision and meta fields (id, createdAt,
 * updatedAt, schema/previewer versions, policies, AI analysis results) are deliberately
 * left out.
 */
function editableFields(project: ProjectManifest) {
  return {
    sortMode: project.sortMode,
    timelineTransitionSeconds: project.timelineTransitionSeconds,
    sources: project.sources,
    timelineOrder: project.timelineOrder,
    excludedMainAssetIds: project.excludedMainAssetIds,
    introSegments: project.introSegments,
    introExcludedSegmentIds: project.introExcludedSegmentIds,
    introTargetDurationMs: project.introTargetDurationMs,
    introSegmentMaxDurationMs: project.introSegmentMaxDurationMs,
    mediaInsertions: project.mediaInsertions,
    subtitleCues: project.subtitleCues,
    bgmTracks: project.bgmTracks,
    sourceAudioVolumePercent: project.sourceAudioVolumePercent ?? DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT,
    aiStoryContext: {
      topic: project.aiStoryContext.topic,
      locations: project.aiStoryContext.locations,
      people: project.aiStoryContext.people,
      storySummary: project.aiStoryContext.storySummary,
      audiencePromise: project.aiStoryContext.audiencePromise,
      subtitleLanguage: project.aiStoryContext.subtitleLanguage,
      introPrompt: project.aiStoryContext.introPrompt ?? "",
      introBaseAssetId: project.aiStoryContext.introBaseAssetId ?? "",
    },
    colorSettings: project.colorSettings,
    watermarkSettings: project.watermarkSettings ?? DEFAULT_WATERMARK_SETTINGS,
    mainStartCue: project.mainStartCue,
    photoSoundEffect: {
      id: project.photoSoundEffect.id,
      volumePercent: project.photoSoundEffect.volumePercent,
    },
  };
}

/** Editable fields of a fresh default project (what main-process createProject() produces). */
const FRESH_PROJECT_FIELDS: ReturnType<typeof editableFields> = {
  sortMode: "SMART_SEQUENCE",
  timelineTransitionSeconds: 0.3,
  sources: [],
  timelineOrder: [],
  excludedMainAssetIds: [],
  introSegments: [],
  introExcludedSegmentIds: [],
  introTargetDurationMs: DEFAULT_INTRO_TARGET_DURATION_MS,
  introSegmentMaxDurationMs: DEFAULT_INTRO_SEGMENT_MAX_DURATION_MS,
  mediaInsertions: [],
  subtitleCues: [],
  bgmTracks: [],
  sourceAudioVolumePercent: DEFAULT_SOURCE_AUDIO_VOLUME_PERCENT,
  aiStoryContext: {
    topic: "",
    locations: [],
    people: [],
    storySummary: "",
    audiencePromise: "",
    subtitleLanguage: "zh",
    introPrompt: "",
    introBaseAssetId: "",
  },
  colorSettings: DEFAULT_PROJECT_COLOR_SETTINGS,
  watermarkSettings: DEFAULT_WATERMARK_SETTINGS,
  mainStartCue: DEFAULT_MAIN_START_CUE_SETTINGS,
  photoSoundEffect: { id: DUNES_SHUTTER_EFFECT_ID, volumePercent: 70 },
};

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    return [...keys].every((key) => sameValue(leftRecord[key], rightRecord[key]));
  }
  return false;
}

/**
 * True when the project differs from a fresh default project on user-editable fields.
 * Used to decide whether leaving an unnamed project needs a save/discard/cancel prompt.
 */
export function hasUnsavedUserEdits(project: ProjectManifest): boolean {
  return !sameValue(editableFields(project), FRESH_PROJECT_FIELDS);
}
