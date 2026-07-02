const { withSettingsGradle } = require('@expo/config-plugins');

const VDOCIPHER_MAVEN_REPOSITORY =
  'maven { url = uri("https://github.com/VdoCipher/maven-repo/raw/master/repo") }';

function addVdoCipherRepository(settingsGradle) {
  if (settingsGradle.includes('github.com/VdoCipher/maven-repo')) {
    return settingsGradle;
  }

  const repositoriesBlock = /(dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{)/;

  if (repositoriesBlock.test(settingsGradle)) {
    return settingsGradle.replace(
      repositoriesBlock,
      `$1\n        ${VDOCIPHER_MAVEN_REPOSITORY}`,
    );
  }

  return `${settingsGradle}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        ${VDOCIPHER_MAVEN_REPOSITORY}
    }
}
`;
}

module.exports = function withVdoCipherMaven(config) {
  return withSettingsGradle(config, (settingsConfig) => {
    settingsConfig.modResults.contents = addVdoCipherRepository(
      settingsConfig.modResults.contents,
    );
    return settingsConfig;
  });
};
