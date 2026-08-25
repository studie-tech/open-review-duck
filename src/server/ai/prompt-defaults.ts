import { AI_PROMPT_KEYS, type AiPromptKey } from "~/config/ai-prompt-catalog";
import {
  REVIEWDUCK_AGENT_QUESTION_TASK_PROMPT,
  REVIEWDUCK_AGENT_SHARED_PROMPT,
  REVIEWDUCK_AGENT_SUBMIT_PROMPT,
  REVIEWDUCK_AGENT_SYSTEM_PROMPT,
  REVIEWDUCK_AGENT_UNIT_TASK_PROMPT,
  SEMANTIC_CLUSTER_REPAIR_PROMPT,
  SEMANTIC_CLUSTER_SYSTEM_PROMPT,
  SEMANTIC_CLUSTER_USER_PROMPT,
} from "~/config/prompts";
import {
  DEEP_REVIEW_CHANGE_PR_ADDED,
  DEEP_REVIEW_CHANGE_PR_DELETED,
  DEEP_REVIEW_CHANGE_PR_MODIFIED,
  DEEP_REVIEW_CHANGE_PR_RENAMED,
  DEEP_REVIEW_CHANGE_REPO_CURRENT,
  DEEP_REVIEW_CHANGE_REPO_DELETED,
  DEEP_REVIEW_DEDUPE_SYSTEM_PROMPT,
  DEEP_REVIEW_DEDUPE_USER_PROMPT,
  DEEP_REVIEW_FINAL_TURN_PROMPT,
  DEEP_REVIEW_PLAN_SYSTEM_PROMPT,
  DEEP_REVIEW_PLAN_USER_PROMPT,
  DEEP_REVIEW_REFUTE_SYSTEM_PROMPT,
  DEEP_REVIEW_REFUTE_USER_PROMPT,
  DEEP_REVIEW_RELOCATE_SYSTEM_PROMPT,
  DEEP_REVIEW_RELOCATE_USER_PROMPT,
  DEEP_REVIEW_REPOSITORY_PLAN_SYSTEM_PROMPT,
  DEEP_REVIEW_REPOSITORY_SCOUT_SYSTEM_PROMPT,
  DEEP_REVIEW_REPOSITORY_SURVEY_SYSTEM_PROMPT,
  DEEP_REVIEW_SCOUT_SYSTEM_PROMPT,
  DEEP_REVIEW_SCOUT_USER_PROMPT,
  DEEP_REVIEW_SURVEY_SYSTEM_PROMPT,
  DEEP_REVIEW_SURVEY_USER_PROMPT,
} from "~/server/review/deep/review-prompts";

const defaults: Record<AiPromptKey, string> = {
  "explain.system": REVIEWDUCK_AGENT_SYSTEM_PROMPT,
  "explain.shared": REVIEWDUCK_AGENT_SHARED_PROMPT,
  "explain.question_task": REVIEWDUCK_AGENT_QUESTION_TASK_PROMPT,
  "explain.unit_task": REVIEWDUCK_AGENT_UNIT_TASK_PROMPT,
  "explain.submit": REVIEWDUCK_AGENT_SUBMIT_PROMPT,
  "semantic.cluster.system": SEMANTIC_CLUSTER_SYSTEM_PROMPT,
  "semantic.cluster.user": SEMANTIC_CLUSTER_USER_PROMPT,
  "semantic.cluster.repair": SEMANTIC_CLUSTER_REPAIR_PROMPT,
  "deep_review.final_turn": DEEP_REVIEW_FINAL_TURN_PROMPT,
  "deep_review.scout.system": DEEP_REVIEW_SCOUT_SYSTEM_PROMPT,
  "deep_review.scout.system_repository":
    DEEP_REVIEW_REPOSITORY_SCOUT_SYSTEM_PROMPT,
  "deep_review.scout.user": DEEP_REVIEW_SCOUT_USER_PROMPT,
  "deep_review.plan.system": DEEP_REVIEW_PLAN_SYSTEM_PROMPT,
  "deep_review.plan.system_repository":
    DEEP_REVIEW_REPOSITORY_PLAN_SYSTEM_PROMPT,
  "deep_review.plan.user": DEEP_REVIEW_PLAN_USER_PROMPT,
  "deep_review.relocate.system": DEEP_REVIEW_RELOCATE_SYSTEM_PROMPT,
  "deep_review.relocate.user": DEEP_REVIEW_RELOCATE_USER_PROMPT,
  "deep_review.refute.system": DEEP_REVIEW_REFUTE_SYSTEM_PROMPT,
  "deep_review.refute.user": DEEP_REVIEW_REFUTE_USER_PROMPT,
  "deep_review.survey.system": DEEP_REVIEW_SURVEY_SYSTEM_PROMPT,
  "deep_review.survey.system_repository":
    DEEP_REVIEW_REPOSITORY_SURVEY_SYSTEM_PROMPT,
  "deep_review.survey.user": DEEP_REVIEW_SURVEY_USER_PROMPT,
  "deep_review.dedupe.system": DEEP_REVIEW_DEDUPE_SYSTEM_PROMPT,
  "deep_review.dedupe.user": DEEP_REVIEW_DEDUPE_USER_PROMPT,
  "deep_review.change.pr_deleted": DEEP_REVIEW_CHANGE_PR_DELETED,
  "deep_review.change.pr_added": DEEP_REVIEW_CHANGE_PR_ADDED,
  "deep_review.change.pr_renamed": DEEP_REVIEW_CHANGE_PR_RENAMED,
  "deep_review.change.pr_modified": DEEP_REVIEW_CHANGE_PR_MODIFIED,
  "deep_review.change.repo_deleted": DEEP_REVIEW_CHANGE_REPO_DELETED,
  "deep_review.change.repo_current": DEEP_REVIEW_CHANGE_REPO_CURRENT,
};

/** Returns the shipped default body for one prompt key. */
export function defaultAiPromptBody(key: AiPromptKey) {
  return defaults[key];
}

/** Returns every shipped default prompt body. */
export function defaultAiPromptBodies() {
  return Object.fromEntries(
    AI_PROMPT_KEYS.map((key) => [key, defaults[key]]),
  ) as Record<AiPromptKey, string>;
}
