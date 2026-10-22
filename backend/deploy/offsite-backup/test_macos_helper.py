"""Security boundary checks for reviewed launch configuration (no TCC mutation)."""
from pathlib import Path
import plistlib
import subprocess
import unittest

BASE = Path(__file__).parent

class MacHelperTests(unittest.TestCase):
    def test_narrow_usage_description_and_fixed_launch_target(self):
        info = plistlib.loads((BASE / 'macos/Info.plist').read_bytes())
        self.assertEqual(info['CFBundleIdentifier'], 'com.kaicloud.q.offsite-backup')
        self.assertIn('NSDesktopFolderUsageDescription', info)
        self.assertEqual([key for key in info if key.endswith('UsageDescription')], ['NSDesktopFolderUsageDescription'])
        launch = plistlib.loads((BASE / 'com.kaicloud.q.offsite-backup.plist').read_bytes())
        self.assertEqual(launch['ProgramArguments'], ['/Users/kai/Library/Application Support/Q/offsite-backup/Q Offsite Backup.app/Contents/MacOS/QBackupLauncher'])
        self.assertTrue(launch['RunAtLoad'])
        self.assertEqual(launch['StartInterval'], 3600)

    def test_prepare_script_syntax_and_rejects_arguments_without_build(self):
        script = BASE / 'macos/prepare-app.sh'
        self.assertEqual(subprocess.run(['/bin/bash', '-n', str(script)], capture_output=True).returncode, 0)
        result = subprocess.run(['/bin/bash', str(script), '--install'], capture_output=True)
        self.assertEqual(result.returncode, 64)
        self.assertNotIn(b'Prepared application', result.stdout)

if __name__ == '__main__':
    unittest.main()
