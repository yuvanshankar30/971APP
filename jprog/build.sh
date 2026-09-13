#!/bin/bash
set -e

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_BUILD="/tmp/java_build_$(basename "$SOURCE_DIR")_$(hostname)"
mkdir -p "$LOCAL_BUILD"

# Copy only the source roots this project actually uses.
# This avoids scanning the entire Google Drive tree.
printf 'Copying source files...\n'
for dir in Display SheetHandler Parser Parts; do
    if [ -d "$SOURCE_DIR/$dir" ]; then
        mkdir -p "$LOCAL_BUILD/$dir"
        cp -R "$SOURCE_DIR/$dir/." "$LOCAL_BUILD/$dir/"
    fi
done

# Include the top-level Java entry points and any other root-level Java files.
for f in "$SOURCE_DIR"/*.java; do
    [ -f "$f" ] && cp "$f" "$LOCAL_BUILD/"
done

cd "$LOCAL_BUILD" || exit 1
find . -name "*.class" -delete

echo "Compiling..."
javac -cp . Runner.java JustinProg.java

echo "Build successful, launching..."
cd "$SOURCE_DIR"
java -cp "$LOCAL_BUILD" Runner

rm -rf "$LOCAL_BUILD"
echo "Done"