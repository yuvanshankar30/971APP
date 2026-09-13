package Parser.GCode;

public interface GenericParser {
    public String parse(String gcodeLine, int lineNum, NGCDocument doc);
}
