package SheetHandler;

import java.nio.file.Path;
import java.nio.file.Paths;

public enum SheetThickness {
    METAL_03125(
            Paths.get(Settings.settings.get("Holes.METAL_030")), "0.03125\""),
    METAL_0625(
            Paths.get(Settings.settings.get("Holes.METAL_060")), "0.0625\""),
    METAL_090(
            Paths.get(Settings.settings.get("Holes.METAL_090")), "0.09\""),
    METAL_125(
            Paths.get(Settings.settings.get("Holes.METAL_125")), "0.125\""),
    METAL_188(
            Paths.get(Settings.settings.get("Holes.METAL_188")), "0.188\""),
    METAL_250(
            Paths.get(Settings.settings.get("Holes.METAL_250")), "0.25\""),
    METAL_3125(
            Paths.get(Settings.settings.get("Holes.METAL_313")), "0.3125\""),
    METAL_375(
            Paths.get(Settings.settings.get("Holes.METAL_375")), "0.375\""),
    METAL_500(
            Paths.get(Settings.settings.get("Holes.METAL_500")), "0.5\""),
    METAL_750(
            Paths.get(Settings.settings.get("Holes.METAL_750")), "0.75\"");

    public final Path holesFile;
    public final String name;

    SheetThickness(Path holesFile, String name) {
        this.holesFile = holesFile;
        this.name = name;
    }

    public String toString() {
        return name;
    }
}