package Parser.GCode;

public class MCodeParserWinCNC implements GenericParser {
    public String parse(String gcodeLine, int lineNum, NGCDocument doc) {
        int code;
        String tempCode = "";
        int indexOfM = gcodeLine.indexOf('M') + 1;
        while (!(indexOfM >= gcodeLine.length() || !(gcodeLine.charAt(indexOfM) != ' '))) {
            tempCode += gcodeLine.charAt(indexOfM);
            indexOfM++;
        }
        code = Integer.parseInt(tempCode);

        switch (code) {
            case 3, 4 -> {
                // S by itself handles it
                return gcodeLine.replace("M" + code, "");
            } // spindle speed
            case 5 -> {
                doc.changeTool(0);
                return gcodeLine.replace("M" + code, "");
            }
            case 6 -> {
            } // tool change
            case 0, 30, 8, 9 -> {
            } // program end(30), coolant or turned off(8 or
            // 9)
            case 7 -> throw new IllegalGCodeError("Mist Coolant is not supported @ line: " + lineNum);
            default ->
                throw new UnknownGCodeError("MCode : " + tempCode + " not parsable @ line: " + lineNum);
        }
        return gcodeLine.replace("M" + code, "");
    }
}
