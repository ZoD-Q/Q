const { withXcodeProject } = require('expo/config-plugins');

const PHASE_NAME = '[Q] Validate API target';
const SHELL_SCRIPT = `set -e
if [[ -f "$SRCROOT/.xcode.env" ]]; then
  source "$SRCROOT/.xcode.env"
fi
if [[ -f "$SRCROOT/.xcode.env.local" ]]; then
  source "$SRCROOT/.xcode.env.local"
fi
export PROJECT_ROOT="$PROJECT_DIR/.."
NODE_BINARY="\${NODE_BINARY:-$(command -v node)}"
if [[ -z "$NODE_BINARY" || ! -x "$NODE_BINARY" ]]; then
  echo "error: Set NODE_BINARY in .xcode.env before building Q." >&2
  exit 1
fi
"$NODE_BINARY" "$PROJECT_ROOT/scripts/validate-native-config.mjs"
`;

function ensureNativeApiGuard(project) {
  const targets = Object.entries(project.pbxNativeTargetSection()).filter(([key, target]) =>
    !key.endsWith('_comment') && String(target.productType).replaceAll('"', '') === 'com.apple.product-type.application');
  if (targets.length !== 1) throw new Error('Q API validation requires exactly one native application target.');
  const [targetId, target] = targets[0];
  let reference = target.buildPhases.find(phase => phase.comment === PHASE_NAME);
  if (!reference) {
    const phase = project.addBuildPhase([], 'PBXShellScriptBuildPhase', PHASE_NAME, targetId, { shellPath: '/bin/bash', shellScript: SHELL_SCRIPT });
    reference = { value: phase.uuid, comment: PHASE_NAME };
  }
  const phase = project.hash.project.objects.PBXShellScriptBuildPhase[reference.value];
  phase.shellPath = '/bin/bash';
  phase.shellScript = JSON.stringify(SHELL_SCRIPT);
  phase.alwaysOutOfDate = 1;
  phase.runOnlyForDeploymentPostprocessing = 0;
  phase.showEnvVarsInLog = 0;
  phase.inputPaths = [];
  phase.outputPaths = [];
  // The check must run even when Debug skips the React Native bundle phase.
  target.buildPhases = [reference, ...target.buildPhases.filter(item => item.value !== reference.value)];
  return project;
}

module.exports = config => withXcodeProject(config, mod => {
  ensureNativeApiGuard(mod.modResults);
  return mod;
});
module.exports.ensureNativeApiGuard = ensureNativeApiGuard;
module.exports.PHASE_NAME = PHASE_NAME;
module.exports.SHELL_SCRIPT = SHELL_SCRIPT;
