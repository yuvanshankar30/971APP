package Parser.GCode;

public class EndParser971 implements GenericParser {
    public String parse(String gcodeLine, int lineNum, NGCDocument doc) {
        gcodeLine = gcodeLine.replace("%", "");
        if (!gcodeLine.isEmpty()) {
            throw new IllegalArgumentException(
                    "The following Gcode at line " + lineNum + " cannot be parsed:\n" + gcodeLine);
        }
        return gcodeLine;
    }
}
