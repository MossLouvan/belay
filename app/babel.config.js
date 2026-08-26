module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated arrives as a transitive dependency of expo-router from SDK 57
    // onward, and its worklets have to be compiled by this plugin. Without it
    // the runtime segfaults inside the worklets JSI bridge rather than raising
    // anything recognisable, so it is required even though nothing here imports
    // Reanimated directly. It must stay last in the list.
    plugins: ['react-native-worklets/plugin'],
  };
};
