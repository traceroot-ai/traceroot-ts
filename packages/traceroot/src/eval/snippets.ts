// src/eval/snippets.ts — canonical copy-paste starter snippets (parity with
// traceroot-py/traceroot/eval/snippets.py).
//
// The SDK owns these so any surface (UI dataset/run pages, docs) templates against the real
// signatures instead of hand-written strings. Mental model (datasets and runs alike):
// bringing something local always means pulling DATA — a dataset at a version.
//   dataset, latest -> pullDataset(datasetId); pinned -> pullDatasetVersion(versionId);
//   reproduce a run -> pullDatasetVersion(run.datasetVersionId). There is no pullRun.

export const LANGUAGES = ['python', 'typescript'] as const;
export type SnippetLang = (typeof LANGUAGES)[number];

const DATASET_ID_PLACEHOLDER = '<dataset_id>';
const VERSION_ID_PLACEHOLDER = '<dataset_version_id>';

function q(value: string | undefined, placeholder: string): string {
  return `"${value ?? placeholder}"`;
}

function checkLang(lang: SnippetLang): void {
  if (!LANGUAGES.includes(lang)) throw new Error(`lang must be one of ${LANGUAGES.join(', ')}`);
}

/** Snippet that pulls a dataset's CURRENT published version. */
export function datasetLatestSnippet(datasetId?: string, lang: SnippetLang = 'python'): string {
  checkLang(lang);
  const ds = q(datasetId, DATASET_ID_PLACEHOLDER);
  if (lang === 'python') {
    return `from traceroot import pull_dataset\n\ndataset = pull_dataset(${ds})  # current published version\n`;
  }
  return `import { pullDataset } from "traceroot";\n\nconst dataset = await pullDataset(${ds});  // current published version\n`;
}

/** Snippet that pulls one EXACT immutable dataset version. */
export function datasetVersionSnippet(
  datasetVersionId?: string,
  lang: SnippetLang = 'python',
): string {
  checkLang(lang);
  const vid = q(datasetVersionId, VERSION_ID_PLACEHOLDER);
  if (lang === 'python') {
    return `from traceroot import pull_dataset_version\n\ndataset = pull_dataset_version(${vid})  # exact immutable version\n`;
  }
  return `import { pullDatasetVersion } from "traceroot";\n\nconst dataset = await pullDatasetVersion(${vid});  // exact immutable version\n`;
}

/** Reproduce a run: pull the exact dataset version it used, then supply your own task +
 *  scorers (only the data is on the platform). The evaluate(...) call is commented out. */
export function reproduceRunSnippet(
  datasetVersionId?: string,
  lang: SnippetLang = 'python',
): string {
  checkLang(lang);
  const vid = q(datasetVersionId, VERSION_ID_PLACEHOLDER);
  if (lang === 'python') {
    return (
      'from traceroot import evaluate, pull_dataset_version\n\n' +
      '# Reproduce a run: pull the EXACT dataset version it scored, then supply your\n' +
      '# own task + scorers. A run is task + scorers + data; only the data lives on\n' +
      '# the platform -- you bring the code (there is no run-pull primitive).\n' +
      `dataset = pull_dataset_version(${vid})\n\n` +
      '# run = evaluate(\n' +
      '#     name="<evaluation name>",\n' +
      '#     dataset=dataset,\n' +
      '#     task=your_task,            # your candidate function\n' +
      '#     scorers=[your_scorer],     # your scorer callables\n' +
      '#     candidate_version="<label>",\n' +
      '#     # baseline=<a prior run>,  # link the comparison\n' +
      '# )\n'
    );
  }
  return (
    'import { evaluate, pullDatasetVersion } from "traceroot";\n\n' +
    '// Reproduce a run: pull the EXACT dataset version it scored, then supply your\n' +
    '// own task + scorers. A run is task + scorers + data; only the data lives on\n' +
    '// the platform -- you bring the code (there is no run-pull primitive).\n' +
    `const dataset = await pullDatasetVersion(${vid});\n\n` +
    '// const run = await evaluate({\n' +
    '//   name: "<evaluation name>",\n' +
    '//   dataset,\n' +
    '//   task: yourTask,            // your candidate function\n' +
    '//   scorers: [yourScorer],     // your scorer callables\n' +
    '//   candidateVersion: "<label>",\n' +
    '//   // baseline: priorRun,     // link the comparison\n' +
    '// });\n'
  );
}
