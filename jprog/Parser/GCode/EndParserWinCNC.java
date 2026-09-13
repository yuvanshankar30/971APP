package Parser.GCode;

public class EndParserWinCNC implements GenericParser {
    public String parse(String gcodeLine, int lineNum, NGCDocument doc) {
        if (gcodeLine.contains("T")) { // tool changer
            int index = gcodeLine.indexOf('T');

            // Extract the substring after 'T' to find the number
            // This handles simple cases "T1" and complex ones "T1 M6"
            String afterT = gcodeLine.substring(index + 1).trim();

            // Find where the number ends (split at first non-digit)
            String[] parts = afterT.split("[^0-9]");

            if (parts.length > 0 && !parts[0].isEmpty()) {
                try {
                    int toolNumber = Integer.parseInt(parts[0]);

                    // Switch the active tool layer and load its offset
                    doc.changeTool(toolNumber);

                    // Remove the T command from the line to prevent double processing
                    gcodeLine = gcodeLine.substring(0, index) + gcodeLine.substring(index + 1 + parts[0].length());

                } catch (NumberFormatException e) {
                    System.err.println("Failed to parse tool number at line " + lineNum);
                }
            }
        }
        if (gcodeLine.contains("S")) {
            int indexOfS = gcodeLine.indexOf('S') + 1;
            String speed = "";
            while (!(indexOfS >= gcodeLine.length() || !(gcodeLine.charAt(indexOfS) != ' '))) {
                speed += gcodeLine.charAt(indexOfS);
                indexOfS++;
            }
            doc.setSpindleSpeed(Integer.parseInt(speed));
            gcodeLine = gcodeLine.replace("S" + speed, "");
        }
        if (!gcodeLine.trim().isEmpty()) {
            throw new IllegalArgumentException(
                    "The following Gcode line cannot be parsed, line: " + lineNum + "\n" + gcodeLine);
        }
        return gcodeLine;
    }
}
